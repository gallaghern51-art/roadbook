// Planner core — the single definition of the optimizer's prompts, tools, and
// model run. Two transports share it: chat.mjs streams NDJSON inside the host's
// request timeout, and planner-background.mjs runs the same job as a background
// function with a 15-minute ceiling, reporting through a blob record.
// Kept out of netlify/functions/ so Netlify does not publish it as an endpoint.

import Anthropic from '@anthropic-ai/sdk';
import { searchPlacesGoogle } from './places-core.mjs';

export const SYSTEM = `You are the planning brain of a motorcycle trip planner — the tool riders use to plan multi-day trips end to end (routes, stops, fuel, lodging, meals, timing). The active trip's identity, dates, riders, bike range, and constraints all come from the provided trip state — read them there, never assume.

You receive the CURRENT trip state plus engine-computed metrics, a stop-by-stop timeline simulation, and a FEASIBILITY STUDY with hard-gate ETA checks, fuel-range analysis against the trip's configured bike range, and per-day scores. Ground every recommendation in that data.

You are authorized to restructure the ENTIRE trip when asked: reorder days, add or remove days, move stops across days, add or remove stops, retime departures, change lodging and meals, adjust trip settings — emit everything as one op list. Waypoint dwell minutes are editable via update_waypoint patch {dwell: N}; departure time via set_day_field field "depart" (e.g. "7:30 AM"); lodging via update_lodging patch {name, status: booked|reserve|none, where, note}; day dates cascade from meta.startDate automatically when days are added/removed/reordered. Trip-level settings edit via set_meta patch — including pace, the riding-duration multiplier every planned leg time scales by (1.0 solo, ~1.08 small group, ~1.15 large group).

SCENARIOS: the app stores named trip permutations. You receive the current scenario list (ids + names). Rules:
- Whenever you produce a route optimization or any restructure bigger than a one-stop tweak, ALWAYS set "saveAs" to a short descriptive name (e.g. "Balanced Monday", "Badlands swap") so the result is saved as a new permutation automatically.
- When the user refers to editing/updating an EXISTING scenario by name, set "overwriteScenarioId" to that scenario's id instead of saveAs. Ops always apply to the current working trip; the result is then written into that scenario.
- Never reuse a name already in the list for saveAs — pick a distinct one.
- Riders switch plans from the Plan strip on the PLAN screen (top of the trip overview and every day panel). On a SHARED trip the strip offers "Load for the group" vs "Just me — personal copy" (a separate unsynced trip seeded from the scenario). When a rider wants a PERSONAL variant — splitting from the group for a day, riding a solo leg while the others keep the plan — build it as a scenario with saveAs and tell them: open the Plan strip and choose "Just me — personal copy" so the group plan stays untouched.

BREAKING UP LOOPS AND LONG DAYS: the digest includes engine-computed break-point recommendations (best split stop, miles/time either side). When asked where or how to break a day or loop up, ground your answer in those; you may refine them (e.g. a better overnight town, a lunch-anchored decision point). Days are pinned to calendar dates, so "splitting" a day means moving stops onto neighboring days, retiming departures, cutting stops, or converting a loop to a shorter out-and-back — say which and show the math.

Non-negotiables unless the user explicitly overrides them:
- Days flagged "anchor" in the trip data are protected — trim anywhere else first.
- Hard time gates in the trip data (day.gates) are commitments, not suggestions.
- Fuel discipline uses the trip's configured range (meta.range). Flag any gap beyond it.
- Group realities scale with rider count: more bikes park slower, eat slower, and fuel slower. Wildlife corridors at dawn/dusk are ridden slow.

TIME BUDGET — the server cuts any reply off after about a minute, and a cut-off answer is worth nothing:
- Produce ONE scenario per reply. When asked for several, build the single most valuable one now with full ops, name the others in one sentence each, and offer to build the next on request.
- Keep op lists to what the change actually requires. Never restate days you are not changing.
- If a request genuinely cannot fit — a ground-up rebuild of every day, or four permutations at once — say so in one line and deliver the first slice instead of starting something that will be severed mid-answer.

NAMING DAYS — this matters, riders do not think in ids:
- NEVER write a raw day id (d3, d8, day_xyz) in prose. Ids belong in tool ops only.
- Refer to a day by its leg: the weekday, the date, and the day's title — e.g. "Fri 8/14 — Lead → Little Bighorn → Red Lodge". Shorten the title to its endpoints if it is long, but always keep the weekday and date.
- On later mentions in the same paragraph a short form is fine ("the Beartooth day", "Friday"), as long as the full leg name appeared first.
- The same applies to stops and modules: name them, never their ids.

OPTIONAL MODULES — a module's prose is the plan's reasoning, so never let it drift out of sync with the route:
- A module carries name/duration/why/tradeoff/logistics text. If you move the underlying activity to another day or another time, you MUST also move or rewrite the module — switching it off and leaving it behind strands text describing a slot that no longer exists.
- Use move_module to change which day owns it, update_module to rewrite its text (name, duration, why, tradeoff, logistics), add_module for a new option, remove_module to drop one. toggle_module only flips it on or off.
- Prefer move_module + update_module over remove_module when an activity relocates — the why/logistics text is researched content worth keeping.
- A module's duration/tradeoff text should agree with the day it now sits on. Do not leave a morning time on a module you moved to an evening, or "two hours on a 14-hour day" on a day that is no longer 14 hours.

How to respond:
- Be direct and honest about trade-offs, in the voice of the field guide: state the cost of every option ("this buys you X but costs you Y").
- When the user asks you to rework, reorder, add, or remove something, USE the propose_trip_changes tool with concrete ops referencing real ids from the trip JSON. Keep the accompanying text short — the proposal card shows the ops.
- When the user asks a question or for analysis, answer in text only. Do not propose changes nobody asked for.
- Waypoints need lat/lng when added; use accurate coordinates for real places.
- When a search_places result becomes a waypoint, copy its id into the waypoint's placeId — routing then snaps to the place itself instead of the raw coordinate (which can force absurd exit-and-re-enter maneuvers).
- The search_places tool returns verified names, addresses, and exact coordinates from the live places database. Use it whenever you add or move a stop whose coordinates you are not fully certain of (restaurants, gas stations, small attractions, lodging) — one focused query per place, then emit the ops using the returned lat/lng. Do not call propose_trip_changes and search_places in the same reply; search first, propose after the results come back. Skip searching for places you already know precisely (major cities, famous landmarks).`;

// Live place lookup for the model — verified coordinates instead of recalled ones.
export const PLACES_TOOL = {
  name: 'search_places',
  description: 'Search the live places database (Google) for real-world locations. Returns up to 6 matches with verified name, address, and exact lat/lng. Use before adding stops whose coordinates you are not certain of.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'What to find, with locality for precision — e.g. "BBQ restaurant Spearfish SD" or "gas station Ten Sleep WY".' },
      near: {
        type: 'object',
        description: 'Optional bias point (e.g. the day\'s route area).',
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
      },
    },
  },
};

// Answer every search_places call in a response; other tool calls in the same
// (malformed) reply get a nudge so the API contract stays satisfied.
async function answerToolCalls(response, emit) {
  const results = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    if (block.name === 'search_places') {
      emit({ type: 'beat', note: 'searching places' });
      let content;
      try {
        const key = process.env.GOOGLE_MAPS_API_KEY;
        if (!key) throw new Error('place search not configured on this site');
        const places = await searchPlacesGoogle(key, block.input?.query ?? '', block.input?.near, { limit: 6 });
        content = JSON.stringify(places.length ? places : { note: 'no matches — try a broader query' });
      } catch (e) {
        content = JSON.stringify({ error: String(e.message).slice(0, 200) });
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
    } else {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: 'Not executed — finish your place searches first, then issue this proposal in your next reply.',
      });
    }
  }
  return results;
}

export const TOOL = {
  name: 'propose_trip_changes',
  description:
    'Propose a set of edits to the trip. The user previews and applies them in the app. Reference real day/waypoint/module ids from the provided trip JSON.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'ops'],
    properties: {
      summary: { type: 'string', description: 'One-sentence summary of what this change set does and its main trade-off.' },
      saveAs: { type: 'string', description: 'Short scenario name. REQUIRED whenever this proposal is a route optimization or multi-day restructure — the app saves the applied result as a new named permutation. Omit only for trivial single-stop tweaks.' },
      overwriteScenarioId: { type: 'string', description: 'Set instead of saveAs when the user asked to edit/update an existing scenario — the id from the provided scenario list. The applied result overwrites that scenario.' },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['reorder_days', 'add_day', 'remove_day', 'reorder_waypoints', 'move_waypoint', 'add_waypoint', 'remove_waypoint', 'update_waypoint', 'set_day_field', 'toggle_module', 'update_module', 'move_module', 'add_module', 'remove_module', 'set_reservation_done', 'add_reservation', 'remove_reservation', 'add_gate', 'update_gate', 'remove_gate', 'update_meal', 'remove_meal', 'update_lodging', 'set_meta'],
            },
            dayId: { type: 'string' },
            dayIds: { type: 'array', items: { type: 'string' } },
            waypointId: { type: 'string' },
            waypointIds: { type: 'array', items: { type: 'string' } },
            fromDayId: { type: 'string' },
            toDayId: { type: 'string' },
            index: { type: 'integer' },
            waypoint: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                note: { type: 'string' },
                lat: { type: 'number' },
                lng: { type: 'number' },
                kind: { type: 'string', enum: ['start', 'via', 'fuel', 'photo', 'end'] },
                fuel: { type: 'boolean' },
                mile: { type: ['number', 'null'] },
                placeId: { type: 'string', description: 'the id returned by search_places — carry it so routing snaps to the place, not the raw coordinate' },
              },
            },
            patch: { type: 'object' },
            field: { type: 'string' },
            value: {},
            moduleId: { type: 'string' },
            enabled: { type: 'boolean' },
            module: {
              type: 'object',
              description: 'For add_module. Optional add-ons default to switched off — use toggle_module to turn one on.',
              properties: {
                name: { type: 'string' },
                duration: { type: 'string' },
                why: { type: 'string' },
                tradeoff: { type: 'string' },
                logistics: { type: 'string' },
              },
            },
            reservationId: { type: 'string' },
            done: { type: 'boolean' },
            meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] },
            day: { type: 'object', description: 'For add_day: {title, phase, depart, summary}. Dates cascade automatically.' },
            gate: {
              type: 'object',
              description: 'For add_gate: a hard be-there-by commitment the feasibility engine grades against. update_gate/remove_gate address gates by their array index on the day.',
              properties: {
                label: { type: 'string' },
                by: { type: 'string', description: 'e.g. "7:00 AM"' },
                waypointId: { type: 'string', description: 'the stop the deadline applies to' },
              },
            },
            reservation: {
              type: 'object',
              description: 'For add_reservation: an entry on the trip-wide booking checklist.',
              properties: {
                name: { type: 'string' },
                when: { type: 'string' },
                where: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
          required: ['op'],
        },
      },
    },
  },
};

// Square-zero trip generation: describe a trip, get a complete structured itinerary.
export const GENERATE_SYSTEM = `You are the itinerary builder for a motorcycle trip planning app. From the rider's description, produce a COMPLETE, realistic multi-day motorcycle itinerary via the generate_trip tool.

Rules:
- Real places, accurate lat/lng (4+ decimals). Route days along roads riders actually take; favor the famous riding roads of the region when they fit.
- 4–10 waypoints per riding day: start point, the best scenic/riding stops (kind "photo"), fuel stops every 100–150 miles in real towns (kind "fuel", fuel: true), lunch-town stops, and the day's end point. First waypoint kind "start", last kind "end".
- Keep daily distance realistic: 150–300 mi for scenic days, up to 450 for transit days, and note it in the summary.
- Every day gets: an honest one-to-two-sentence summary (trade-offs included), a depart time, lunch and dinner meal entries with real restaurant-quality picks when you know them (or the honest "best option in town" note), and lodging (real town + property suggestion, status "reserve").
- Phases: use "outbound" for the way out, "rally" for event/destination days, "return" for the way home, "prep" for travel/arrival days.
- Gates: when a day contains a hard real-world deadline — park-entrance cutoffs, timed-entry windows, ferry or tour departures, rental returns, restaurant reservations — emit it in day.gates ({label, by, waypointIndex}). Real commitments only; never invent one.
- meta.summary: two to three sentences on the whole trip — the shape of the route, the landmark days, the rider count.
- Respect the rider count and requested day count exactly.`;

export const GENERATE_TOOL = {
  name: 'generate_trip',
  description: 'Emit the complete generated itinerary.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['trip'],
    properties: {
      trip: {
        type: 'object',
        additionalProperties: false,
        required: ['meta', 'days'],
        properties: {
          meta: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              subtitle: { type: 'string' },
              summary: { type: 'string', description: 'Two-to-three sentences describing the whole trip: the shape of the route, the landmark days, and the rider count. Shown at the top of the trip overview.' },
              riders: { type: 'integer' },
              fuelRule: { type: 'string' },
            },
          },
          days: {
            type: 'array',
            items: {
              type: 'object',
              required: ['title', 'waypoints'],
              properties: {
                title: { type: 'string' },
                phase: { type: 'string', enum: ['prep', 'outbound', 'rally', 'return'] },
                depart: { type: 'string', description: 'e.g. "8:00 AM"' },
                summary: { type: 'string' },
                anchor: { type: 'boolean' },
                constraints: { type: 'array', items: { type: 'string' } },
                gates: {
                  type: 'array',
                  description: 'Hard be-there-by deadlines the feasibility engine will grade against. Only real-world commitments.',
                  items: {
                    type: 'object',
                    required: ['label', 'by', 'waypointIndex'],
                    properties: {
                      label: { type: 'string' },
                      by: { type: 'string', description: 'e.g. "7:00 AM"' },
                      waypointIndex: { type: 'integer', description: '0-based index into this day\'s waypoints array' },
                    },
                  },
                },
                waypoints: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'lat', 'lng'],
                    properties: {
                      name: { type: 'string' },
                      lat: { type: 'number' },
                      lng: { type: 'number' },
                      kind: { type: 'string', enum: ['start', 'via', 'fuel', 'photo', 'end'] },
                      fuel: { type: 'boolean' },
                      dwell: { type: 'number' },
                      note: { type: 'string' },
                      placeId: { type: 'string', description: 'Google place id when known (from search_places) — routing snaps to the place itself' },
                    },
                  },
                },
                meals: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      meal: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] },
                      name: { type: 'string' }, where: { type: 'string' }, note: { type: 'string' }, alt: { type: 'string' },
                    },
                  },
                },
                lodging: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['booked', 'reserve', 'none'] },
                    name: { type: 'string' }, where: { type: 'string' }, note: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// Netlify sync functions cap at ~10s; streaming responses can run much longer,
// but not forever. If the platform kills the function mid-answer the socket just
// closes and the client is left with no idea why — so every path here has to end
// with a terminal line of our own, ahead of any external deadline.
// Measured on this site: the host severs the stream at ~58s. Sit just under it
// so the model gets nearly the whole window and we still own the ending —
// past the cap the socket dies and no explanation reaches the rider.
// Raise PLANNER_BUDGET_MS only alongside the site's function timeout.

// Streaming transport sits under the host's request timeout — measured at ~58s
// on this site. The background transport answers to the 15-minute background
// ceiling instead, so it gets a far larger share.
export const BUDGET_MS = Number(process.env.PLANNER_BUDGET_MS) || 50000;
export const BACKGROUND_BUDGET_MS = Number(process.env.PLANNER_BACKGROUND_BUDGET_MS) || 600000;

// The SDK retries 429/529 silently, honouring retry-after — which on a rate
// limit is tens of seconds of no events at all, indistinguishable from a slow
// model. Bound it so the real error surfaces instead of a budget expiring with
// nothing to show for it.
export const makeClient = () => new Anthropic({ maxRetries: 1 });

// Upstream failures arrive as raw status + JSON body. Riders get a sentence.
export function friendlyError(err) {
  const status = err?.status;
  if (status === 429) return 'The optimizer is rate limited right now — wait a minute and try again.';
  if (status === 529 || status === 503) return 'The model service is busy right now. Try again in a moment.';
  if (status === 401 || status === 403) return 'The Anthropic API key on this site was rejected — check it in the Netlify environment settings.';
  if (status >= 500) return 'The model service errored out. Try again in a moment.';
  return String(err?.message ?? err);
}

// Race the model against our own budget. Losing the race is a normal outcome we
// can explain; being killed by the host is not.
export function withDeadline(stream, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { stream.abort(); } catch { /* already finished */ }
      const err = new Error('planner deadline exceeded');
      err.code = 'deadline';
      reject(err);
    }, ms);
    stream.finalMessage().then(
      (msg) => { clearTimeout(timer); resolve(msg); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Tool arguments stream as input_json_delta and reasoning as thinking_delta —
// neither fires a 'text' event, so a big restructure is otherwise dead air.
// Track all three phases: it drives the progress readout, and when a budget
// runs out it tells us how far the model actually got.
export function trackProgress(stream, emit) {
  const seen = { chars: 0, thinking: 0, text: 0 };
  let lastPing = 0;
  stream.on('streamEvent', (event) => {
    if (event?.type !== 'content_block_delta') return;
    const delta = event.delta ?? {};
    if (delta.type === 'thinking_delta') {
      seen.thinking += delta.thinking?.length ?? 0;
    } else if (delta.type === 'text_delta') {
      seen.text += delta.text?.length ?? 0;
      return; // already emitted as a 'delta'
    } else if (delta.type === 'input_json_delta') {
      seen.chars += delta.partial_json?.length ?? 0;
    } else {
      return;
    }
    const total = seen.chars + seen.thinking;
    if (total - lastPing >= 400) {
      lastPing = total;
      emit({ type: 'building', chars: seen.chars, thinking: seen.thinking });
    }
  });
  return seen;
}

// What to tell the rider when a budget runs out, based on how far it got.
export function deadlineMessage(seen, { background = false } = {}) {
  const scope = background
    ? ' Even the long-running job could not finish it — split the request.'
    : '';
  if (seen.chars > 0) {
    return 'The change set was too large to finish in the time allowed. Ask for one day, or one leg, at a time and apply them in sequence.' + scope;
  }
  if (seen.text > 0) {
    return 'The optimizer answered partway, then ran out of time before it could write the changes. Ask it to change one day at a time.' + scope;
  }
  if (seen.thinking > 0) {
    return 'The optimizer was still working through the trip when time ran out. Ask for one scenario, or one day, rather than several at once.' + scope;
  }
  return 'The optimizer ran out of time without starting — the model service is likely slow right now. Try again in a moment.';
}

// Trip context rides in the first user turn so the conversation stays clean.
export function buildChatMessages({ messages, tripDigest, tripJson, scenarios }) {
  const contextBlock = `<trip_state_digest>\n${tripDigest}\n</trip_state_digest>\n\n<saved_scenarios>\n${JSON.stringify(scenarios)}\n</saved_scenarios>\n\n<trip_json>\n${JSON.stringify(tripJson)}\n</trip_json>`;
  return messages.map((m, i) => (
    i === 0 && m.role === 'user'
      ? { role: 'user', content: `${contextBlock}\n\n${m.content}` }
      : { role: m.role, content: m.content }
  ));
}

// One optimizer turn. `emit` receives the same event shapes on both transports,
// so the client reads a streamed run and a polled run identically.
export async function runChat({ client, body, emit, budgetMs = BUDGET_MS, background = false }) {
  const { messages = [], tripDigest = '', tripJson = null, scenarios = [] } = body;
  const convo = buildChatMessages({ messages, tripDigest, tripJson, scenarios });
  const t0 = Date.now();
  let allText = '';

  // Agentic loop: the model may call search_places (answered server-side) any
  // number of rounds before its final answer / proposal, within the budget.
  for (let round = 0; round < 4; round++) {
    const remaining = budgetMs - (Date.now() - t0);
    if (remaining < 8000) {
      emit({ type: 'error', message: 'Ran out of time while looking places up — ask again, or for a smaller change.' });
      return;
    }
    const stream = client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      // Summarized display costs nothing extra but makes thinking stream real
      // text — without it thinking deltas are empty, the progress readout sits
      // silent for the whole thinking phase, and a deadline during it gets
      // misdiagnosed as "the model never started".
      thinking: { type: 'adaptive', display: 'summarized' },
      system: SYSTEM,
      tools: [TOOL, PLACES_TOOL],
      messages: convo,
    });
    stream.on('text', (t) => emit({ type: 'delta', text: t }));
    const progress = trackProgress(stream, emit);

    let response;
    try {
      response = await withDeadline(stream, remaining);
    } catch (err) {
      if (err?.code !== 'deadline') throw err;
      emit({ type: 'error', message: deadlineMessage(progress, { background }) });
      return;
    }
    if (response.stop_reason === 'refusal') {
      emit({ type: 'done', text: 'The optimizer declined that request. Try rephrasing it.', proposal: null });
      return;
    }
    if (response.stop_reason === 'max_tokens') {
      // Tool arguments are truncated JSON at this point — unusable.
      emit({ type: 'error', message: 'The answer hit its length limit before it was complete. Ask for a smaller change set — one day at a time applies cleanly.' });
      return;
    }

    let text = '';
    let proposal = null;
    let searched = false;
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use' && block.name === 'propose_trip_changes') proposal = block.input;
      if (block.type === 'tool_use' && block.name === 'search_places') searched = true;
    }
    if (text.trim()) allText += (allText ? '\n\n' : '') + text.trim();

    if (!searched) {
      emit({ type: 'done', text: allText, proposal });
      return;
    }
    // Answer the searches and go around again (a stray proposal in the same
    // reply gets deferred by answerToolCalls).
    const toolResults = await answerToolCalls(response, emit);
    convo.push({ role: 'assistant', content: response.content });
    convo.push({ role: 'user', content: toolResults });
  }
  emit({ type: 'error', message: 'Too many place lookups in one request — ask for a smaller change.' });
}

// Square-zero trip generation.
export async function runGenerate({ client, body, emit, budgetMs = BUDGET_MS }) {
  const { prompt, basics = {} } = body;
  const ask = `Build this motorcycle trip:\n\n"${prompt}"\n\nBasics (respect exactly): name: ${basics.name || '(you pick a good one)'}, start date: ${basics.startDate}, days: ${basics.numDays}, riders: ${basics.riders}. Use the generate_trip tool.`;
  const stream = client.messages.stream({
    model: 'claude-sonnet-5',
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    // See runChat — keeps the progress readout alive through the thinking
    // phase, which on a full-trip build is most of the wall time.
    thinking: { type: 'adaptive', display: 'summarized' },
    system: GENERATE_SYSTEM,
    tools: [GENERATE_TOOL],
    tool_choice: { type: 'tool', name: 'generate_trip' },
    messages: [{ role: 'user', content: ask }],
  });
  trackProgress(stream, emit);
  let response;
  try {
    response = await withDeadline(stream, budgetMs);
  } catch (err) {
    if (err?.code !== 'deadline') throw err;
    emit({ type: 'error', message: 'The builder ran out of time before the itinerary was complete. Try fewer days, or a shorter description.' });
    return;
  }
  if (response.stop_reason === 'refusal') {
    emit({ type: 'error', message: 'The builder declined that request — try rephrasing.' });
    return;
  }
  if (response.stop_reason === 'max_tokens') {
    // The SDK assembles tool input with a partial-JSON parser, so a truncated
    // itinerary still parses — into a trip that silently lost its tail (days,
    // waypoints, lodging). Refuse it rather than hand over a short trip.
    emit({ type: 'error', message: 'The itinerary hit its length limit before it was complete — try fewer days, or a shorter description.' });
    return;
  }
  const block = response.content.find((b) => b.type === 'tool_use' && b.name === 'generate_trip');
  if (!block?.input?.trip) emit({ type: 'error', message: 'No itinerary produced — try a more specific description.' });
  else emit({ type: 'done', trip: block.input.trip });
}

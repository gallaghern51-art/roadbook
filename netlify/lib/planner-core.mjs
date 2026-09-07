// Planner core — the single definition of the optimizer's prompts, tools, and
// model run. Two transports share it: chat.mjs streams NDJSON inside the host's
// request timeout, and planner-background.mjs runs the same job as a background
// function with a 15-minute ceiling, reporting through a blob record.
// Kept out of netlify/functions/ so Netlify does not publish it as an endpoint.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { searchPlacesGoogle } from './places-core.mjs';
import { evaluateRouteOptions, preserveAdditiveRefinement } from './route-opportunities.mjs';
import { verifyTrip, verifyProposal, describeVerification, findPlace, SPECS } from './verify-places.mjs';

export const SYSTEM = `You are the planning brain of a motorcycle trip planner — the tool riders use to plan multi-day trips end to end (routes, stops, fuel, lodging, meals, timing). The active trip's identity, dates, riders, bike range, and constraints all come from the provided trip state — read them there, never assume.

You receive the CURRENT trip state plus engine-computed metrics, a stop-by-stop timeline simulation, and a FEASIBILITY STUDY with hard-gate ETA checks, fuel-range analysis against the trip's configured bike range, and per-day scores. Ground every recommendation in that data.

You are authorized to restructure the ENTIRE trip when asked: reorder days, add or remove days, move stops across days, add or remove stops, retime departures, change lodging and meals, adjust trip settings — emit everything as one op list. Waypoint dwell minutes are editable via update_waypoint patch {dwell: N}; departure time via set_day_field field "depart" (e.g. "7:30 AM"); lodging via update_lodging patch {name, status: booked|reserve|none, where, note}; day dates cascade from meta.startDate automatically when days are added/removed/reordered. Trip-level settings edit via set_meta patch — including pace, the riding-duration multiplier every planned leg time scales by (1.0 solo, ~1.08 small group, ~1.15 large group), and routePrefs {style: quick|touring|backroads, avoidTolls: boolean}, the trip-wide motorcycle routing choice used by both Plan and Ride.

SCENARIOS: the app stores named trip permutations. You receive the current scenario list (ids + names). Rules:
- Whenever you produce a route optimization or any restructure bigger than a one-stop tweak, ALWAYS set "saveAs" to a short descriptive name (e.g. "Balanced Monday", "Badlands swap") so the result is saved as a new permutation automatically.
- When the user refers to editing/updating an EXISTING scenario by name, set "overwriteScenarioId" to that scenario's id instead of saveAs. Ops always apply to the current working trip; the result is then written into that scenario.
- Never reuse a name already in the list for saveAs — pick a distinct one.
- Riders switch plans from the Plans strip on the PLAN screen (top of the trip overview; a compact pill on each day panel). On a SHARED trip both the strip and your proposal card fork the decision: "for the group" (the swap syncs to every rider) vs "Just me — new trip" (a separate unsynced trip seeded from the scenario). When a rider wants a PERSONAL variant — splitting from the group for a day, riding a solo leg while the others keep the plan — build it as a scenario with saveAs and tell them to choose "Just me — new trip" so the group plan stays untouched.

BREAKING UP LOOPS AND LONG DAYS: the digest includes engine-computed break-point recommendations (best split stop, miles/time either side). When asked where or how to break a day or loop up, ground your answer in those; you may refine them (e.g. a better overnight town, a lunch-anchored decision point). Days are pinned to calendar dates, so "splitting" a day means moving stops onto neighboring days, retiming departures, cutting stops, or converting a loop to a shorter out-and-back — say which and show the math.

Non-negotiables unless the user explicitly overrides them:
- Days flagged "anchor" in the trip data are protected — trim anywhere else first.
- Hard time gates in the trip data (day.gates) are commitments, not suggestions.
- Lodging with status "booked" is a hard anchor and defines the overnight/day boundary. Never move it, replace it, or change its city during an ordinary route-character refinement. Lodging with status "reserve" may be offered as an alternative, but only with the trade-off stated and the rider choosing it explicitly.
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

DAY TITLE AND SUMMARY — the same rule, one level up. A day's title and summary describe a specific route ("US-212 to the WY-296 junction, Chief Joseph down to WY-120"). They are stored text; nothing regenerates them:
- Whenever your ops change which stops a day has, where they are, or what order they come in, emit set_day_field "summary" for that day in the SAME proposal, rewritten against the new route and its new numbers. A description naming a stop you just removed is worse than no description — riders read it as the plan.
- Rewrite the title too when the endpoints or the headline stops change; leave it alone for a mid-route tweak that does not change what the day IS.
- Keep the summary one to two sentences in the field-guide voice, honest about the trade-off the change buys, and consistent with the day's miles and hours after your edit.
- If the rider explicitly asks only for a route change and nothing else, still update the text — it is part of the change, not an extra.

How to respond:
- Be direct and honest about trade-offs, in the voice of the field guide: state the cost of every option ("this buys you X but costs you Y").
- When the user asks you to rework, reorder, add, or remove something, USE the propose_trip_changes tool with concrete ops referencing real ids from the trip JSON. Keep the accompanying text short — the proposal card shows the ops.
- When the user asks a question or for analysis, answer in text only. Do not propose changes nobody asked for.
- Waypoints need lat/lng when added; use accurate coordinates for real places.
- When a search_places result becomes a waypoint, copy its id into the waypoint's placeId — routing then snaps to the place itself instead of the raw coordinate (which can force absurd exit-and-re-enter maneuvers).
- The search_places tool returns verified names, addresses, exact coordinates, and weekly opening hours from the live places database. Use it whenever you add or move a stop whose coordinates you are not fully certain of (restaurants, gas stations, small attractions, lodging) — one focused query per place, then emit the ops using the returned lat/lng. Do not call propose_trip_changes and search_places in the same reply; search first, propose after the results come back. Skip searching for places you already know precisely (major cities, famous landmarks).
- FUEL STOPS ARE STATIONS, NOT TOWNS: when you add or move a fuel stop, search_places for an actual gas station ("gas station <town>") and emit the station's name, exact coordinates, and placeId. Prefer a station at the highway exit or directly on the route so the group is never dragged through town for gas. A bare town-center pin flagged fuel is not acceptable.
- THIS IS ENFORCED, NOT TRUSTED: any fuel stop, lodging, or restaurant in your proposal that arrives WITHOUT a placeId is looked up server-side before the rider sees it — a real one is snapped to its true coordinates, an invented one is flagged "unverified" in the plan and the correction is stated in your reply. Searching first is how you avoid being corrected in public.
- HOURS MUST LINE UP: before recommending a restaurant, lodging, or any stop the plan puts a time on, compare its opening hours (in the search_places result) against the day's simulated ETA at that stop — never propose a place that will be closed when the riders arrive, and if hours are missing say the pick is unverified.
- ROUTE OPPORTUNITIES: when the rider asks to find, compare, or improve roads/stops/fuel/food/lodging/attractions, search the live places first, then call evaluate_route_options on 2–3 ordered bundles before recommending one. Explain the measured detour and fuel/time tradeoffs. Do not propose ops in that same reply; let the rider choose or combine pieces, then propose the selected change in their next turn.
- ROUTE-CHARACTER RECONCILIATION: after a trip exists, Quick/Touring/Back roads changes are replans, not cosmetic settings. Preserve booked lodging, overnight cities, trip endpoints, hard gates, and explicitly reserved experiences. First evaluate the hard-anchor corridor with the requested routePrefs; then pass its returned searchAlongRouteId as routeOptionId to search_places so Google ranks flexible replacements along that exact Valhalla road shape. Preserve the role and time slot of flexible stops while researching lower-detour replacements. A fuel station may change; safe fuel coverage may not. A restaurant or lodging change must update both its itinerary record and the corresponding route waypoint so Valhalla actually visits it. Present replacements piece by piece before proposing ops. The final accepted proposal is one atomic op list and includes set_meta routePrefs.`;

export const EXPLORE_SYSTEM = `You are Roadbook's AI-native motorcycle trip designer. You are having a planning conversation BEFORE a trip exists. Turn the rider's intent into 2–3 meaningfully different route-and-stop concepts they can compare, question and refine before committing.

This is not a generic "twisty roads" picker. Discover the best opportunities inside the trip the rider described: memorable roads, safe fuel anchors, food worth the stop, lodging that improves the shape of the next day, and attractions that justify their detour. Explain what each bundle buys and costs for this specific group.

Required workflow:
1. Use search_places for any business or smaller attraction you recommend. Search focused candidates near the intended corridor. Results are live Google Places facts; copy ids and coordinates exactly. For each food, lodging, or attraction location, also include preferenceTags: 1–3 broad, durable descriptors you author from the concept (for example "breakfast diner", "Italian", "boutique hotel", or "history museum"). Do not put ratings, addresses, opening hours, or other measured Places facts in preferenceTags.
2. Build 2–3 ordered route concepts and call evaluate_route_options. Include start/end plus the significant road anchors and verified opportunity stops. Keep each concept to 20 locations maximum; if space is tight, remove redundant road-shape anchors, never a stop or a later day. Use kind road, fuel, food, lodging or attraction, and realistic dwell minutes. Every overnight MUST be kind lodging: the evaluator uses lodging anchors as day boundaries so its longest-day, after-dark and fuel checks are meaningful on a multi-day trip. ALWAYS pass through the routePrefs from <trip_basics> unchanged, so the miles, time and arrival you present are measured with the same road preferences the created trip will be planned and ridden with.
3. After the evaluator returns, call present_route_options. Reference the evaluated concept ids. Never invent miles, time, arrival, fuel gap, climbing or detour cost — Roadbook attaches those measured values itself.

On a follow-up, read the prior conversation and the previously presented concepts. A localized request is a PATCH to each option, not permission to summarize or reconstruct the rest: reuse the prior option ids, retain every unchanged location in exact day/order, apply only the requested edits, then evaluate the complete options. Never omit later-day locations to save output space. Preserve what the rider likes, research/evaluate the requested refinement, and present a fresh comparison. Ask one concise question only when a missing fact would materially change the route; otherwise make and label a sensible assumption.

When <rider_place_preferences> is present, treat it as soft evidence learned from the rider's prior confirmed choices and replacements. Use it to rank otherwise-good candidates, never to violate route, hours, range, budget or group constraints. A useful surprise may beat habit; briefly say when a recommendation deliberately does.

<trip_basics> may carry `savedPlaces` — places this rider has SAVED, each with a real lat/lng and a role of home, work or favorite. When the rider says "from home", "back to the house", "my place" or names a saved label, that place IS the answer: use its exact coordinates and placeId. Never geocode a guess for a place the rider has already given you, and never ask which city they mean when a saved place answers it. If they refer to a place they have not saved, ask or search as usual.

<trip_basics> may also carry `riderTaste` — what this rider stated outright in Settings. `dietary` and `avoid` are REQUIREMENTS: do not propose a stop that cannot feed them, or a road or place they said to avoid, and say so plainly if their request and those two collide. `food`, `lodging` and `interests` are strong preferences that outrank <rider_place_preferences> (which is inferred from past picks) when the two disagree — a stated fact beats an inferred one. `notes` is free text about how they ride; read it.

Route character is the rider's setting, not yours to guess. <trip_basics> carries routePrefs {style: quick|touring|backroads, avoidTolls: boolean}: style is the highway appetite and avoidTolls removes tolled roads, bridges and tunnels from the routing entirely. Never silently substitute different preferences — if a concept only works under other settings, present it under the rider's settings and say plainly what changing them would buy.

Tolls and city crossings are a real cost on a motorcycle — money at a booth, and lane-splitting traffic through a dense core. Watch the geometry before you anchor a leg on a crossing: when the origin and the next stop are on the SAME side of a river, bay or estuary, a route that crosses and re-crosses is almost always the router taking a nominally faster toll crossing rather than the surface corridor the rider wants — name the same-side corridor as a road anchor so the concept follows it. When avoidTolls is true, no concept may depend on a tolled crossing. When it is false, still call out each toll crossing or city-centre transit in the tradeoff, and say what it saves.

Group reality matters: rider count affects pace, parking, meal time and fuel time. A stop is not valuable merely because it is popular. Prefer combinations that make the whole day work. Flag opening-hours uncertainty, risky fuel gaps, after-dark arrival, and options that add a lot of saddle time.

Use text only for a short conversational lead-in. Put the actual choices in present_route_options. Do not generate a full itinerary and do not propose trip ops in this mode.`;

// Live place lookup for the model — verified coordinates instead of recalled ones.
export const PLACES_TOOL = {
  name: 'search_places',
  description: 'Search the live places database (Google) for real-world locations. Returns up to 6 matches with verified name, address, exact lat/lng, and weekly opening hours. When evaluate_route_options returns a searchAlongRouteId, pass it as routeOptionId to rank candidates along that exact Valhalla corridor.',
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
      encodedPolyline: {
        type: 'string',
        description: 'Optional precision-5 encoded corridor. Prefer routeOptionId so the server carries the exact route without copying a long encoded value.',
      },
      routeOptionId: {
        type: 'string',
        description: 'The searchAlongRouteId returned by evaluate_route_options. Uses Google Places Search Along Route on that exact Valhalla corridor; prefer this over near for route-character reconciliation.',
      },
    },
  },
};

export const ROUTE_OPTIONS_TOOL = {
  name: 'evaluate_route_options',
  description: 'Have Valhalla route and measure 2–3 ordered motorcycle route-and-stop concepts. Returns trusted distance, group-paced riding time, arrival, detour delta, fuel gap, and best-effort elevation gain.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['concepts'],
    properties: {
      depart: { type: 'string', description: '24-hour local departure time, e.g. 08:00.' },
      pace: { type: 'number', description: 'Group duration multiplier; usually 1.08 for a small group and 1.15 for a large one.' },
      range: {
        type: 'object',
        properties: { comfort: { type: 'number' }, absolute: { type: 'number' } },
      },
      routePrefs: {
        type: 'object',
        properties: {
          style: { type: 'string', enum: ['quick', 'touring', 'backroads'] },
          avoidTolls: { type: 'boolean' },
        },
      },
      concepts: {
        type: 'array', minItems: 2, maxItems: 3,
        items: {
          type: 'object', required: ['id', 'title', 'locations'],
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            locations: {
              type: 'array', minItems: 2, maxItems: 20,
              items: {
                type: 'object', required: ['name', 'lat', 'lng', 'kind'],
                properties: {
                  name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' },
                  kind: { type: 'string', enum: ['start', 'end', 'road', 'fuel', 'food', 'lodging', 'attraction'] },
                  detail: { type: 'string' }, placeId: { type: 'string' }, dwell: { type: 'number' },
                  rating: { type: 'number' }, userRatingCount: { type: 'integer' }, priceLevel: { type: 'string' },
                  googleMapsUri: { type: 'string' }, websiteUri: { type: 'string' }, phone: { type: 'string' },
                  primaryType: { type: 'string' }, types: { type: 'array', items: { type: 'string' } },
                  preferenceTags: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
                  hours: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const PRESENT_OPTIONS_TOOL = {
  name: 'present_route_options',
  description: 'Present the evaluated choices to the rider. Roadbook joins these explanations to trusted evaluator metrics and verified locations.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'recommendedId', 'options'],
    properties: {
      message: { type: 'string', description: 'A concise comparison and what you recommend.' },
      recommendedId: { type: 'string' },
      options: {
        type: 'array', minItems: 2, maxItems: 3,
        items: {
          type: 'object', required: ['evaluationId', 'summary', 'routeDescription', 'why', 'groupFit', 'tradeoff'],
          properties: {
            evaluationId: { type: 'string' },
            summary: { type: 'string' },
            routeDescription: { type: 'string' },
            why: { type: 'string' },
            groupFit: { type: 'string' },
            tradeoff: { type: 'string' },
          },
        },
      },
    },
  },
};

const enrichOpportunityLocation = (location, fact) => {
  if (!fact) return;
  location.name = fact.name || location.name;
  location.detail = fact.detail || location.detail;
  location.placeId = fact.id || location.placeId;
  for (const field of [
    'hours', 'rating', 'userRatingCount', 'priceLevel', 'googleMapsUri',
    'websiteUri', 'phone', 'primaryType', 'types',
  ]) {
    if (fact[field] !== undefined && fact[field] !== null) location[field] = fact[field];
  }
};

async function verifyOpportunityBusinesses(input, emit, {
  key = process.env.GOOGLE_MAPS_API_KEY, searchImpl, placeFacts,
} = {}) {
  const copy = structuredClone(input ?? {});
  for (const concept of copy.concepts ?? []) {
    for (const location of concept.locations ?? []) {
      enrichOpportunityLocation(location, placeFacts?.get(location.placeId));
    }
  }
  if (!key) return copy;
  const tasks = (copy.concepts ?? []).flatMap((concept) => (concept.locations ?? [])
    .filter((location) => SPECS[location.kind])
    .map((location) => ({ location, spec: SPECS[location.kind] })));
  if (!tasks.length) return copy;
  emit({ type: 'beat', note: 'verifying option stops' });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      if (task.location.placeId) {
        task.location.verified = 'google';
        continue;
      }
      try {
        const hit = await findPlace(key, {
          name: task.location.name,
          near: { lat: task.location.lat, lng: task.location.lng },
          spec: task.spec,
          searchImpl,
        });
        if (!hit) {
          task.location.verified = false;
          continue;
        }
        task.location.name = hit.name || task.location.name;
        task.location.lat = hit.lat;
        task.location.lng = hit.lng;
        task.location.placeId = hit.id;
        enrichOpportunityLocation(task.location, hit);
        task.location.verified = 'google';
      } catch {
        // A Places outage is not evidence that a stop is fake. Leave it
        // unstamped; the UI distinguishes unchecked from checked-and-missing.
      }
    }
  });
  await Promise.all(workers);
  return copy;
}

// Answer every search_places call in a response; other tool calls in the same
// (malformed) reply get a nudge so the API contract stays satisfied.
async function answerToolCalls(response, emit, {
  routeResults = null, routeOpts = {}, verifyOpts = {}, refinement = null, placeFacts = null,
  reconciliation = null, defaultRoutePrefs = null,
} = {}) {
  const corridorFor = (optionId) => [...(routeResults ?? [])].reverse()
    .flatMap((evaluation) => evaluation.options ?? [])
    .find((option) => option.id === optionId)?.searchPolyline ?? null;
  const results = [];
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;
    if (block.name === 'search_places') {
      emit({ type: 'beat', note: 'searching places' });
      let content;
      try {
        const key = verifyOpts.key ?? process.env.GOOGLE_MAPS_API_KEY;
        if (!key) throw new Error('place search not configured on this site');
        const search = verifyOpts.searchImpl ?? searchPlacesGoogle;
        const corridor = corridorFor(block.input?.routeOptionId);
        const places = await search(key, block.input?.query ?? '', block.input?.near, {
          limit: 6,
          hours: true,
          enrich: true,
          classify: true,
          encodedPolyline: corridor || block.input?.encodedPolyline || null,
        });
        if (corridor && reconciliation) reconciliation.corridorSearchUsed = true;
        for (const place of places) placeFacts?.set(place.id, place);
        content = JSON.stringify(places.length ? places : { note: 'no matches — try a broader query' });
      } catch (e) {
        content = JSON.stringify({ error: String(e.message).slice(0, 200) });
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
    } else if (block.name === 'evaluate_route_options') {
      emit({ type: 'beat', note: 'routing options' });
      let content;
      try {
        const completeInput = preserveAdditiveRefinement(
          block.input,
          refinement?.concepts,
          refinement?.request,
        );
        // A model that omits routePrefs must not silently be measured under the
        // evaluator's own defaults: the rider set these, and a concept routed
        // with tolls allowed when the rider asked to avoid them is measured
        // against roads the trip will never take. Field report (Sep 7, 2026):
        // a Weehawken -> Nyack leg — same bank of the Hudson — was routed
        // through the Lincoln Tunnel and back over the GWB.
        if (defaultRoutePrefs && !completeInput.routePrefs) completeInput.routePrefs = defaultRoutePrefs;
        const verifiedInput = await verifyOpportunityBusinesses(completeInput, emit, { ...verifyOpts, placeFacts });
        const evaluation = await evaluateRouteOptions(verifiedInput, routeOpts);
        routeResults?.push(evaluation);
        if (reconciliation) {
          reconciliation.routeEvaluations += 1;
          if (reconciliation.corridorSearchUsed) {
            reconciliation.postSearchEvaluation = true;
            reconciliation.routePrefs = completeInput.routePrefs ?? reconciliation.requestedPrefs ?? null;
          }
        }
        // The server retains the long encoded polylines. The model only needs
        // the stable option id to search the same corridor on its next turn.
        content = JSON.stringify({
          ...evaluation,
          options: (evaluation.options ?? []).map(({ searchPolyline: _searchPolyline, ...option }) => ({
            ...option,
            searchAlongRouteId: option.id,
          })),
        });
      } catch (e) {
        content = JSON.stringify({ error: String(e.message).slice(0, 200) });
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content });
    } else {
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: reconciliation
          ? 'Not executed — a route-character proposal requires a Valhalla corridor evaluation, a Google Places search using its routeOptionId, and a final Valhalla evaluation after replacements. Complete those checks first.'
          : 'Not executed — finish your place searches first, then issue this proposal in your next reply.',
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
            patch: {
              type: 'object',
              description: 'Fields for the selected op. For set_meta, routePrefs accepts {style: quick|touring|backroads, avoidTolls: boolean}; it controls both planned routes and Ride Mode reroutes.',
            },
            field: {
              type: 'string',
              description: 'For set_day_field: one of title, summary, depart, arrive, phase, anchor, miles, hours. Rewrite "summary" (and "title" when the endpoints change) alongside any op that changes the day\'s stops.',
            },
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
- When the request includes a confirmed construction plan, treat it as the rider's decision: preserve the selected route order, verified placeIds/coordinates, opportunity roles, and explicit tradeoffs. Expand it into day-by-day detail without silently swapping the chosen pieces. If the selected route spans several days, use lodging anchors as day boundaries and distribute mileage realistically.
- Real places, accurate lat/lng (4+ decimals). Route days along roads riders actually take; favor the famous riding roads of the region when they fit.
- 4–10 waypoints per riding day: start point, the best scenic/riding stops (kind "photo"), fuel stops every 100–150 miles at real gas stations you know — the station's own coordinates at the highway exit, never a bare town-center pin (kind "fuel", fuel: true) — lunch-town stops, and the day's end point. First waypoint kind "start", last kind "end".
- EVERY gas station, hotel, and restaurant you name is checked against the live places database after you answer: real ones get snapped to their exact coordinates, and anything that does not exist is flagged "unverified" in the rider's plan. So name the specific businesses you are actually confident about (brand and town — "Sinclair, Ten Sleep WY"), and where you are NOT confident, say so in the note or write an honest placeholder ("best option in town") rather than inventing a name. A guessed station is worse than an unnamed one: riders plan fuel around it.
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
                      name: { type: 'string', description: 'A real, specific restaurant — or an honest placeholder like "best option in town" when you are not confident one exists. Named picks are verified against the places database.' },
                      where: { type: 'string' }, note: { type: 'string' }, alt: { type: 'string' },
                    },
                  },
                },
                lodging: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['booked', 'reserve', 'none'] },
                    name: { type: 'string', description: 'A real, specific property — verified against the places database after you answer.' },
                    where: { type: 'string' }, note: { type: 'string' },
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
  // A rolling tail of the summarized reasoning. Held RAW — the display line is
  // derived at emit time, because trimming in place and appending to the
  // trimmed result would splice the ellipsis into the middle of a sentence.
  let tail = '';
  stream.on('streamEvent', (event) => {
    if (event?.type !== 'content_block_delta') return;
    const delta = event.delta ?? {};
    if (delta.type === 'thinking_delta') {
      seen.thinking += delta.thinking?.length ?? 0;
      tail = (tail + (delta.thinking ?? '')).slice(-600);
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
      emit({ type: 'building', chars: seen.chars, thinking: seen.thinking, thought: lastLine(tail) });
    }
  });
  return seen;
}

// Reasoning summaries arrive as prose with headings and blank lines. Keep the
// last non-empty line, trimmed to something that fits one row of a status
// strip — this is a glance, not a transcript.
export function lastLine(text, max = 120) {
  const line = String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean).pop() ?? '';
  const clean = line.replace(/^[#*\-\s]+/, '').replace(/\*\*/g, '').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
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
export function buildChatMessages({ messages, tripDigest, tripJson, scenarios, preferenceProfile = null }) {
  const preferenceBlock = preferenceProfile
    ? `\n\n<rider_place_preferences>\n${JSON.stringify(preferenceProfile)}\n</rider_place_preferences>`
    : '';
  const contextBlock = `<trip_state_digest>\n${tripDigest}\n</trip_state_digest>\n\n<saved_scenarios>\n${JSON.stringify(scenarios)}\n</saved_scenarios>\n\n<trip_json>\n${JSON.stringify(tripJson)}\n</trip_json>${preferenceBlock}`;
  return messages.map((m, i) => (
    i === 0 && m.role === 'user'
      ? { role: 'user', content: `${contextBlock}\n\n${m.content}` }
      : { role: m.role, content: m.content }
  ));
}

// Route-character reconciliation may move flexible recommendations, but its
// fixed anchors are enforced at the server boundary rather than entrusted to
// model prose. This is intentionally narrower than general trip editing: a
// rider can still explicitly change a booking or gate in an ordinary request.
export function routeReconciliationViolations(trip, proposal) {
  const days = new Map((trip?.days ?? []).map((day) => [day.id, day]));
  const lockedWaypoints = new Set();
  const bookedDays = new Set();
  const protectedDays = new Set();
  const completedReservations = new Set((trip?.reserveNow ?? []).filter((item) => item.done).map((item) => item.id));

  for (const day of trip?.days ?? []) {
    const waypoints = day.waypoints ?? [];
    if (waypoints[0]?.id) lockedWaypoints.add(waypoints[0].id);
    if (waypoints.at(-1)?.id) lockedWaypoints.add(waypoints.at(-1).id);
    for (const gate of day.gates ?? []) if (gate.waypointId) lockedWaypoints.add(gate.waypointId);
    if (day.lodging?.status === 'booked') bookedDays.add(day.id);
    if (day.anchor || day.lodging?.status === 'booked' || (day.gates ?? []).length) protectedDays.add(day.id);
  }

  const violations = [];
  for (const op of proposal?.ops ?? []) {
    const waypointId = op.waypointId;
    if (['add_day', 'reorder_days'].includes(op.op)) {
      violations.push('the trip’s protected day boundaries');
    }
    if (['remove_waypoint', 'move_waypoint'].includes(op.op) && lockedWaypoints.has(waypointId)) {
      violations.push('a trip endpoint or timed stop');
    }
    if (op.op === 'move_waypoint') {
      const from = days.get(op.fromDayId);
      const to = days.get(op.toDayId);
      if (op.fromDayId !== op.toDayId || (from?.gates ?? []).length || (to?.gates ?? []).length) {
        violations.push('a protected day or timed-stop order');
      }
    }
    if (op.op === 'update_waypoint' && lockedWaypoints.has(waypointId)) {
      const routeFields = ['name', 'lat', 'lng', 'kind', 'placeId'];
      if (routeFields.some((field) => field in (op.patch ?? {}))) violations.push('a trip endpoint or timed stop');
    }
    if (op.op === 'reorder_waypoints') {
      const original = days.get(op.dayId)?.waypoints ?? [];
      if (original.length && (op.waypointIds?.[0] !== original[0]?.id || op.waypointIds?.at(-1) !== original.at(-1)?.id)) {
        violations.push('an overnight or trip endpoint');
      }
      const nextIndex = new Map((op.waypointIds ?? []).map((id, index) => [id, index]));
      if ((days.get(op.dayId)?.gates ?? []).some((gate) => (
        nextIndex.get(gate.waypointId) !== original.findIndex((waypoint) => waypoint.id === gate.waypointId)
      ))) {
        violations.push('a timed-stop order');
      }
    }
    if (op.op === 'update_lodging' && bookedDays.has(op.dayId)) violations.push('booked lodging');
    if (op.op === 'remove_day') {
      violations.push(protectedDays.has(op.dayId) ? 'an anchored or committed day' : 'the trip’s protected day boundaries');
    }
    if (op.op === 'set_day_field' && op.field === 'anchor') violations.push('an anchored or committed day');
    if (['update_gate', 'remove_gate'].includes(op.op)) violations.push('a hard time gate');
    if (op.op === 'remove_reservation' && completedReservations.has(op.reservationId)) violations.push('a completed reservation');
    if (op.op === 'set_reservation_done' && op.done === false && completedReservations.has(op.reservationId)) violations.push('a completed reservation');
  }
  return [...new Set(violations)];
}

// One optimizer turn. `emit` receives the same event shapes on both transports,
// so the client reads a streamed run and a polled run identically.
// `verifyOpts` is a test seam: it overrides the places key and search
// implementation so the verification wiring can be exercised without a live
// Google account. Production passes nothing and gets the real database.
export async function runChat({ client, body, emit, budgetMs = BUDGET_MS, background = false, verifyOpts = {}, routeOpts = {} }) {
  const {
    messages = [], tripDigest = '', tripJson = null, scenarios = [], preferenceProfile = null,
    reconciliationProof = null,
  } = body;
  const convo = buildChatMessages({ messages, tripDigest, tripJson, scenarios, preferenceProfile });
  const t0 = Date.now();
  let allText = '';
  const placeFacts = new Map();
  const routeResults = [];
  const latestUser = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const marker = latestUser.match(/<route_reconciliation_request>(.*?)<\/route_reconciliation_request>/s);
  let requestedPrefs = null;
  try { requestedPrefs = marker ? JSON.parse(marker[1])?.routePrefs ?? null : null; } catch { requestedPrefs = null; }
  const tripHash = createHash('sha256').update(JSON.stringify(tripJson ?? null)).digest('hex');
  const reconciliation = {
    requested: Boolean(marker), requestedPrefs,
    routeEvaluations: 0, corridorSearchUsed: false, postSearchEvaluation: false, routePrefs: null,
  };
  const proofMatches = (prefs) => {
    if (!reconciliationProof || reconciliationProof.version !== 1 || reconciliationProof.tripHash !== tripHash) return false;
    const proved = reconciliationProof.routePrefs ?? {};
    return (!prefs?.style || prefs.style === proved.style)
      && (typeof prefs?.avoidTolls !== 'boolean' || prefs.avoidTolls === proved.avoidTolls);
  };
  const proofReady = () => (
    reconciliation.routeEvaluations >= 2
    && reconciliation.corridorSearchUsed
    && reconciliation.postSearchEvaluation
  );
  const proofPayload = () => proofReady() ? {
    version: 1,
    tripHash,
    routePrefs: reconciliation.routePrefs ?? reconciliation.requestedPrefs,
  } : null;

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
      tools: [TOOL, PLACES_TOOL, ROUTE_OPTIONS_TOOL],
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
    let researched = false;
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use' && block.name === 'propose_trip_changes') proposal = block.input;
      if (block.type === 'tool_use' && ['search_places', 'evaluate_route_options'].includes(block.name)) researched = true;
    }
    if (text.trim()) allText += (allText ? '\n\n' : '') + text.trim();

    if (!researched) {
      const routePrefsOp = proposal?.ops?.find((op) => op.op === 'set_meta' && op.patch?.routePrefs);
      if (routePrefsOp && !proofReady() && !proofMatches(routePrefsOp.patch.routePrefs)) {
        const toolResults = await answerToolCalls(response, emit, {
          routeResults, routeOpts, verifyOpts, placeFacts, reconciliation,
        });
        convo.push({ role: 'assistant', content: response.content });
        convo.push({ role: 'user', content: toolResults });
        continue;
      }
      if (routePrefsOp) {
        const violations = routeReconciliationViolations(tripJson, proposal);
        if (violations.length) {
          const reason = violations.join(', ');
          allText += `${allText ? '\n\n' : ''}Roadbook blocked this proposal because it changed ${reason}. Those commitments stay fixed during a route-character replan.`;
          emit({ type: 'done', text: allText, proposal: null, reconciliationProof: proofPayload() });
          return;
        }
      }
      // The prompt ASKS the model to search before it commits a station or a
      // property; this is what makes it true. Only stops that arrived without
      // a placeId cost a lookup — a model that used the tool pays nothing.
      // Corrections are announced, never applied behind the rider's back.
      if (proposal?.ops?.length) {
        try {
          const left = budgetMs - (Date.now() - t0);
          const check = await verifyProposal(proposal, {
            trip: tripJson,
            deadline: Date.now() + (background ? 60000 : Math.max(0, Math.min(12000, left + 3000))),
            emit,
            ...verifyOpts,
          });
          const line = describeVerification(check);
          if (line) allText += (allText ? '\n\n' : '') + line;
        } catch {
          /* the proposal stands unverified rather than not at all */
        }
      }
      emit({ type: 'done', text: allText, proposal, reconciliationProof: proofPayload() });
      return;
    }
    // Answer the searches and go around again (a stray proposal in the same
    // reply gets deferred by answerToolCalls).
    const toolResults = await answerToolCalls(response, emit, {
      routeResults, routeOpts, verifyOpts, placeFacts, reconciliation,
    });
    convo.push({ role: 'assistant', content: response.content });
    convo.push({ role: 'user', content: toolResults });
  }
  emit({ type: 'error', message: 'Too many place lookups in one request — ask for a smaller change.' });
}

function priorConceptContext(concepts = []) {
  if (!concepts.length) return '';
  return `\n\n<previous_route_options>\n${JSON.stringify(concepts)}\n</previous_route_options>`;
}

// Pre-trip conversation. The model researches; Valhalla measures; the rider
// decides. A generated itinerary is deliberately impossible from this mode.
export async function runExplore({ client, body, emit, budgetMs = BUDGET_MS, background = false, routeOpts = {}, verifyOpts = {} }) {
  const { messages = [], basics = {}, concepts = [], preferenceProfile = null } = body;
  const preferenceBlock = preferenceProfile
    ? `\n\n<rider_place_preferences>\n${JSON.stringify(preferenceProfile)}\n</rider_place_preferences>`
    : '';
  const basicsBlock = `<trip_basics>\n${JSON.stringify(basics)}\n</trip_basics>${preferenceBlock}${priorConceptContext(concepts)}`;
  const convo = messages.map((m, i) => ({
    role: m.role,
    content: i === 0 && m.role === 'user' ? `${basicsBlock}\n\n${m.content}` : m.content,
  }));
  const t0 = Date.now();
  let allText = '';
  const routeResults = [];
  const placeFacts = new Map();
  const latestRequest = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  for (let round = 0; round < 7; round++) {
    const remaining = budgetMs - (Date.now() - t0);
    if (remaining < 8000) {
      emit({ type: 'error', message: 'I ran out of time comparing the route choices. Try a narrower region or fewer must-have stops.' });
      return;
    }
    const stream = client.messages.stream({
      model: 'claude-sonnet-5',
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      thinking: { type: 'adaptive', display: 'summarized' },
      system: EXPLORE_SYSTEM,
      tools: [PLACES_TOOL, ROUTE_OPTIONS_TOOL, PRESENT_OPTIONS_TOOL],
      messages: convo,
    });
    stream.on('text', (text) => emit({ type: 'delta', text }));
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
      emit({ type: 'done', text: 'I could not plan that request. Try rephrasing the ride you want.', concepts: [] });
      return;
    }
    if (response.stop_reason === 'max_tokens') {
      emit({ type: 'error', message: 'The comparison became too large to finish. Try fewer must-have places.' });
      return;
    }

    let text = '';
    let presented = null;
    let needsTools = false;
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
      if (block.type === 'tool_use' && block.name === 'present_route_options') presented = block.input;
      if (block.type === 'tool_use' && ['search_places', 'evaluate_route_options'].includes(block.name)) needsTools = true;
    }
    if (text.trim()) allText += (allText ? '\n\n' : '') + text.trim();

    if (presented) {
      const evaluated = new Map(routeResults.flatMap((r) => r.options ?? []).map((o) => [o.id, o]));
      const joined = (presented.options ?? []).map((option) => {
        const facts = evaluated.get(option.evaluationId);
        return facts ? { ...option, id: facts.id, title: facts.title, locations: facts.locations, metrics: facts.metrics, error: facts.error } : null;
      }).filter(Boolean);
      if (joined.length) {
        emit({
          type: 'done',
          text: [allText, presented.message].filter(Boolean).join('\n\n'),
          concepts: joined,
          recommendedId: joined.some((o) => o.id === presented.recommendedId) ? presented.recommendedId : joined[0].id,
        });
        return;
      }
    }

    if (!needsTools) {
      emit({ type: 'done', text: allText || 'Tell me what kind of trip you want to build.', concepts: [] });
      return;
    }
    const toolResults = await answerToolCalls(response, emit, {
      routeResults,
      routeOpts,
      verifyOpts,
      refinement: { concepts, request: latestRequest },
      placeFacts,
      defaultRoutePrefs: basics.routePrefs ?? null,
    });
    convo.push({ role: 'assistant', content: response.content });
    convo.push({ role: 'user', content: toolResults });
  }
  emit({ type: 'error', message: 'That plan needed too many research rounds. Narrow the request and try again.' });
}

// Square-zero trip generation.
//
// Generate mode is single-shot and tool_choice-forced, so unlike chat it has
// no search tool and the model's places are RECALLED, not looked up. That is
// how an invented gas station reached a real trip (Great Falls, Aug 2026).
// Every generated itinerary therefore goes through verify-places before it is
// handed over: real stations, real properties, real restaurants — and an
// explicit unverified flag on anything the places database cannot confirm.
export async function runGenerate({ client, body, emit, budgetMs = BUDGET_MS, background = false, verifyOpts = {} }) {
  const { prompt, basics = {} } = body;
  const t0 = Date.now();
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
  if (!block?.input?.trip) {
    emit({ type: 'error', message: 'No itinerary produced — try a more specific description.' });
    return;
  }

  // Resolve the recalled places against the live database. The background
  // transport has a 15-minute ceiling and gives this all the room it needs;
  // the streaming fallback gets whatever is left of its ~58s window plus a
  // small grace, and anything it cannot reach is left UNSTAMPED rather than
  // marked failed. Verification never costs us the itinerary: verifyTrip
  // swallows its own failures and the trip goes out either way.
  const left = budgetMs - (Date.now() - t0);
  const verifyMs = background ? 90000 : Math.max(0, Math.min(12000, left + 3000));
  let verify = null;
  try {
    verify = await verifyTrip(block.input.trip, { deadline: Date.now() + verifyMs, emit, ...verifyOpts });
  } catch {
    /* best-effort by design — a places outage must not lose a built trip */
  }
  emit({ type: 'done', trip: block.input.trip, verify });
}

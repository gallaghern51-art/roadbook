// Place verification — every AI-authored gas station, hotel, and restaurant
// checked against the live places database BEFORE it reaches a rider's plan.
//
// Why this exists (field report, Aug 16, 2026 — a trip built to Great Falls):
// "one of the fuel stops that AI put in wasn't an actual gas station."
// It was not a model slip so much as a missing mechanism. Generate mode
// (`runGenerate`) is a single-shot, tool_choice-forced call with NO search
// tool: every station, property, and diner in a freshly built trip came out of
// the model's memory and nothing ever looked it up. Chat mode DOES have
// search_places, but the prompt only ASKS the model to use it — a proposal
// that skipped the search sailed through unchecked. A recalled gas station is
// the worst kind of wrong: it is plausible, it is on the map, it grades clean
// in the fuel-range engine, and the group finds out at a quarter tank.
//
// The fix is deterministic rather than another paragraph of prompt. After the
// model answers, every stop it put a real-world identity on is resolved
// against Google Places with a TYPE filter (`gas_station` / `lodging` /
// `restaurant`, strict), and:
//   - found        → the stop is SNAPPED to the real thing (name, exact
//                    coordinates, placeId so routing aims at the place) and
//                    stamped `verified: 'google'`.
//   - not found    → the stop is stamped `verified: false` and carries a note
//                    saying so. It is never silently deleted: the rider chose
//                    a route through that town and a flagged stop they can
//                    re-pick beats a hole in the fuel plan.
//   - not checked  → no stamp at all (no key configured, budget ran out).
//                    Absence of a stamp is never presented as a failure, so
//                    seed and hand-built trips are not retroactively nagged.
//
// Stops the model already carried a placeId on (it DID call search_places) are
// trusted and cost nothing — the ~2s/stop and the Places call only get spent
// where the identity is unproven.

import { searchPlacesGoogle } from './places-core.mjs';

// What each class of stop has to BE, and how far from the model's pin the real
// one is still the same intent. Fuel is tightest: a station 12 mi off the pin
// is a different fuel plan, and the range engine grades on that distance.
export const SPECS = {
  fuel: { type: 'gas_station', maxMi: 12, hours: false, label: 'gas station', generic: 'gas station' },
  lodging: { type: 'lodging', maxMi: 20, hours: true, label: 'lodging', generic: null },
  food: { type: 'restaurant', maxMi: 20, hours: true, label: 'restaurant', generic: null },
};

// Concurrency: Places answers in ~200-400ms, so a pool of 4 turns a 12-stop
// trip into ~1s of wall time. Higher risks the per-minute quota on a site
// where a whole crew may be generating trips at once.
const POOL = 4;
// Backstop against a pathological trip (30 days x 8 stops) burning the budget
// and the Places quota in one build.
const MAX_LOOKUPS = 80;

const R_MI = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

export function milesBetween(a, b) {
  if (!a || !b) return Infinity;
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return Infinity;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Names the model writes when it has no actual pick. Searching for these
// returns whatever restaurant happens to be nearest, which would dress a
// non-answer up as a verified one — worse than leaving the honest placeholder.
const PLACEHOLDER = /^(tbd|n\/?a|none|various|options?|open|unknown|self[- ]catered|packed lunch|picnic|camp(site|ing)?( food)?|rider'?s? choice|your choice|best (option|available|in town)|whatever|local (spot|diner|option)s?|grab[- ]and[- ]go)\b/i;

export function isPlaceholderName(name) {
  const s = String(name ?? '').trim();
  if (s.length < 3) return true;
  if (PLACEHOLDER.test(s)) return true;
  // "Best option in town", "options in Ten Sleep" — a description of a search,
  // not the result of one.
  return /\b(best option|option in town|somewhere|anywhere|any )\b/i.test(s);
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'at', 'in', 'on', 'near', 'by', 'station', 'gas', 'fuel', 'stop']);

const tokens = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((w) => w && !STOPWORDS.has(w));

// How much of the requested name the candidate actually carries, 0..1.
//
// Measured in both directions and taken at the better of the two, because the
// model writes a name plus its locality ("Sinclair, Great Falls") while the
// database stores the business alone ("Sinclair") — one-directional scoring
// would read that perfect match as a third.
//
// The HEAD token then guards the obvious failure of a symmetric measure: a
// result named for the town alone ("Great Falls") is entirely contained in
// "Heritage Inn Great Falls" and would otherwise score 1.0. The first
// distinctive word of a request is the business's own name, so a candidate
// missing it is probably a different business — usually the locality itself,
// or the neighbour that happens to sit in it.
export function nameOverlap(want, got) {
  const a = tokens(want);
  const b = tokens(got);
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const forward = a.filter((w) => setB.has(w)).length / a.length;
  const back = b.filter((w) => setA.has(w)).length / b.length;
  const score = Math.max(forward, back);
  // Discounted rather than zeroed: it can still win a ranking when nothing
  // better came back, but it can never pass for an exact match.
  return setB.has(a[0]) ? score : score * 0.35;
}

// Rank the candidates the database returned, after dropping anything closed
// for good or further from the pin than this class of stop tolerates.
//
// Two orders, because the two queries mean different things. A NAMED query
// ("Sinclair, Ten Sleep") is asking about a specific business, so the best
// name match wins and distance only breaks ties — Places matches on address
// text too, and the nearest result to a "<brand> <town>" query is regularly
// some other brand that merely sits in that town. The GENERIC fallback
// ("gas station") is asking what is actually here, and there the nearest one
// to the planned pin is the answer that keeps the route honest.
function best(candidates, { want, near, maxMi, prefer = 'distance' }) {
  let winner = null;
  for (const c of candidates) {
    if (c.status && c.status !== 'OPERATIONAL') continue; // closed for good
    const mi = milesBetween(near, c);
    if (!(mi <= maxMi)) continue;
    const cand = { ...c, mi, overlap: nameOverlap(want, c.name) };
    if (!winner) { winner = cand; continue; }
    if (prefer === 'name') {
      // Bucketed to a tenth so two near-identical name matches are settled by
      // distance rather than by a rounding artifact.
      const better = Math.round(cand.overlap * 10) - Math.round(winner.overlap * 10);
      if (better > 0 || (better === 0 && cand.mi < winner.mi)) winner = cand;
    } else if (cand.mi < winner.mi) {
      winner = cand;
    }
  }
  return winner;
}

// Resolve one stop. Two stages, and the second is the one that catches the
// invented station: if nothing matching the model's NAME exists near the pin,
// ask what actually IS there of that type. A plan that wanted fuel in Great
// Falls gets the real Cenex on the way out of town instead of a name nobody
// can pull into.
export async function findPlace(key, { name, near, spec, searchImpl }) {
  const search = searchImpl ?? searchPlacesGoogle;
  const run = (query) => search(key, query, near, {
    limit: 6,
    hours: spec.hours,
    type: spec.type,
    classify: true,
    radiusM: Math.round(spec.maxMi * 1609.34),
  });

  const named = String(name ?? '').trim();
  if (named && !isPlaceholderName(named)) {
    const hit = best(await run(named), { want: named, near, maxMi: spec.maxMi, prefer: 'name' });
    if (hit) return { ...hit, exact: hit.overlap >= 0.5 };
  }
  if (!spec.generic) return null;
  // Fallback: whatever real one is nearest the pin.
  const hit = best(await run(spec.generic), { want: named, near, maxMi: spec.maxMi });
  return hit ? { ...hit, exact: false } : null;
}

// Bounded worker pool. Tasks past the deadline or the lookup cap are left
// UNTOUCHED rather than marked failed — an unchecked stop and a checked-and-
// missing stop are different facts and the rider is told a different thing.
async function pool(tasks, worker, { deadline, maxLookups }) {
  let next = 0;
  let used = 0;
  let skipped = 0;
  const take = () => {
    if (next >= tasks.length) return null;
    if (Date.now() > deadline || used >= maxLookups) { skipped += tasks.length - next; next = tasks.length; return null; }
    used += 1;
    return tasks[next++];
  };
  const runners = Array.from({ length: Math.min(POOL, tasks.length) }, async () => {
    for (let task = take(); task; task = take()) {
      try {
        await worker(task);
      } catch {
        // A verification that itself failed (quota, network) is not evidence
        // the place is fake. Leave the stop unstamped.
      }
    }
  });
  await Promise.all(runners);
  return { used, skipped };
}

const UNVERIFIED_MARK = '⚠ Unverified';
const stripMark = (note) => String(note ?? '').replace(/⚠ Unverified[^|]*(\|\s*)?/g, '').trim();

const unverifiedNote = (spec) => `${UNVERIFIED_MARK} — no ${spec.label} found at this pin. Re-pick it with search before you ride.`;

// Fold a resolved place onto a waypoint. The coordinates AND the identity move
// together: placeId is what makes google-route aim at the place itself rather
// than the raw coordinate (see routing.js), so a verified stop also stops
// drawing exit-and-re-enter spurs.
function applyToWaypoint(w, hit, spec) {
  if (!hit) {
    w.verified = false;
    const base = stripMark(w.note);
    w.note = base ? `${unverifiedNote(spec)} | ${base}` : unverifiedNote(spec);
    return { moved: 0 };
  }
  const moved = milesBetween(w, hit);
  w.name = hit.name || w.name;
  w.lat = hit.lat;
  w.lng = hit.lng;
  w.placeId = hit.id;
  w.verified = 'google';
  w.mile = null; // legacy field-guide mileage no longer describes this pin
  const base = stripMark(w.note);
  w.note = hit.detail && !base.includes(hit.detail) ? (base ? `${hit.detail} | ${base}` : hit.detail) : base;
  return { moved };
}

// Which stops on a day are anchors for a text-only entry (lodging, meals have
// no coordinates of their own). Lunch belongs mid-route; the rest bracket it.
function anchorFor(day, meal) {
  const wps = (day.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (!wps.length) return null;
  if (meal === 'breakfast') return wps[0];
  if (meal === 'lunch') return wps[Math.floor((wps.length - 1) / 2)];
  return wps[wps.length - 1]; // dinner, and lodging: where the day ends
}

// Collect the verification work a trip needs, in priority order: fuel first
// (running dry is the failure with no workaround at 9pm in Montana), then the
// bed, then the meals.
export function planVerification(trip) {
  const tasks = [];
  for (const day of trip?.days ?? []) {
    for (const w of day.waypoints ?? []) {
      const isFuel = w.fuel === true || w.kind === 'fuel';
      if (!isFuel) continue;
      if (w.placeId) { w.verified = w.verified ?? 'model'; continue; } // came from search_places
      if (!Number.isFinite(w.lat) || !Number.isFinite(w.lng)) continue;
      tasks.push({ rank: 0, kind: 'fuel', day, target: w, name: w.name, near: { lat: w.lat, lng: w.lng } });
    }
  }
  for (const day of trip?.days ?? []) {
    const l = day.lodging;
    if (!l || l.status === 'none' || isPlaceholderName(l.name)) continue;
    if (l.placeId) { l.verified = l.verified ?? 'model'; continue; }
    const near = anchorFor(day, 'lodging');
    if (near) tasks.push({ rank: 1, kind: 'lodging', day, target: l, name: l.name, near });
  }
  for (const day of trip?.days ?? []) {
    for (const m of day.meals ?? []) {
      if (isPlaceholderName(m.name)) continue;
      if (m.placeId) { m.verified = m.verified ?? 'model'; continue; }
      const near = anchorFor(day, m.meal);
      if (near) tasks.push({ rank: 2, kind: 'food', day, target: m, name: m.name, near });
    }
  }
  return tasks.sort((a, b) => a.rank - b.rank);
}

// Verify a whole generated trip in place. Returns a report; never throws —
// a plan that could not be checked is still a plan, and losing the itinerary
// to a Places outage would be a far worse bug than the one this fixes.
export async function verifyTrip(trip, {
  key = process.env.GOOGLE_MAPS_API_KEY,
  deadline = Date.now() + 60000,
  maxLookups = MAX_LOOKUPS,
  emit,
  searchImpl,
} = {}) {
  const report = { checked: 0, snapped: 0, unverified: [], skipped: 0, configured: Boolean(key) };
  if (!key || !trip?.days?.length) return report;

  const tasks = planVerification(trip);
  if (!tasks.length) return report;
  emit?.({ type: 'beat', note: `verifying ${tasks.length} places` });

  let done = 0;
  const worker = async (task) => {
    const spec = SPECS[task.kind];
    const hit = await findPlace(key, { name: task.name, near: task.near, spec, searchImpl });
    report.checked += 1;
    if (task.kind === 'fuel') {
      const { moved } = applyToWaypoint(task.target, hit, spec);
      if (hit && moved > 0.05) report.snapped += 1;
    } else if (hit) {
      const t = task.target;
      t.name = hit.name || t.name;
      t.where = hit.detail || t.where;
      t.placeId = hit.id;
      t.verified = 'google';
      if (hit.hours) t.hours = hit.hours;
      report.snapped += 1;
    } else {
      task.target.verified = false;
      const base = stripMark(task.target.note);
      task.target.note = base ? `${unverifiedNote(spec)} | ${base}` : unverifiedNote(spec);
    }
    if (!hit) report.unverified.push({ day: task.day.title ?? task.day.id, kind: task.kind, name: task.name });
    done += 1;
    if (done % 4 === 0) emit?.({ type: 'beat', note: `verifying places ${done}/${tasks.length}` });
  };

  const { skipped } = await pool(tasks, worker, { deadline, maxLookups });
  report.skipped = skipped;
  return report;
}

// ---------------------------------------------------------------------------
// Chat proposals: the same check, applied to ops before the rider sees them.
// The model has search_places here and usually uses it — this only spends a
// lookup where a real-world stop arrived WITHOUT a placeId, i.e. exactly the
// case the prompt failed to enforce.

const dayOf = (trip, dayId) => (trip?.days ?? []).find((d) => d.id === dayId) ?? null;
const wpOf = (day, id) => (day?.waypoints ?? []).find((w) => w.id === id) ?? null;

export function planOpVerification(ops, trip) {
  const tasks = [];
  for (const op of ops ?? []) {
    if (op.op === 'add_waypoint') {
      const w = op.waypoint ?? {};
      if (!(w.fuel === true || w.kind === 'fuel') || w.placeId) continue;
      if (!Number.isFinite(w.lat) || !Number.isFinite(w.lng)) continue;
      tasks.push({ kind: 'fuel', op, target: w, name: w.name, near: { lat: w.lat, lng: w.lng } });
      continue;
    }
    if (op.op === 'update_waypoint') {
      const patch = op.patch ?? {};
      if (patch.placeId) continue;
      // Only a relocation or rename needs re-proving; a dwell edit does not.
      if (!('lat' in patch || 'lng' in patch || 'name' in patch)) continue;
      const day = dayOf(trip, op.dayId);
      const cur = wpOf(day, op.waypointId);
      if (!cur) continue;
      const merged = { ...cur, ...patch };
      if (!(merged.fuel === true || merged.kind === 'fuel')) continue;
      if (!Number.isFinite(merged.lat) || !Number.isFinite(merged.lng)) continue;
      tasks.push({ kind: 'fuel', op, target: patch, name: merged.name, near: { lat: merged.lat, lng: merged.lng } });
      continue;
    }
    if (op.op === 'update_lodging') {
      const patch = op.patch ?? {};
      if (!patch.name || patch.placeId || isPlaceholderName(patch.name)) continue;
      const near = anchorFor(dayOf(trip, op.dayId) ?? {}, 'lodging');
      if (near) tasks.push({ kind: 'lodging', op, target: patch, name: patch.name, near });
      continue;
    }
    if (op.op === 'update_meal') {
      const patch = op.patch ?? {};
      if (!patch.name || patch.placeId || isPlaceholderName(patch.name)) continue;
      const near = anchorFor(dayOf(trip, op.dayId) ?? {}, op.meal);
      if (near) tasks.push({ kind: 'food', op, target: patch, name: patch.name, near });
    }
  }
  return tasks;
}

// Verify a proposal's ops in place. Returns { corrected[], unverified[] } so
// the reply can SAY what was changed — a silent coordinate rewrite would be
// its own kind of dishonesty.
export async function verifyProposal(proposal, {
  trip,
  key = process.env.GOOGLE_MAPS_API_KEY,
  deadline = Date.now() + 20000,
  maxLookups = 12,
  emit,
  searchImpl,
} = {}) {
  const out = { corrected: [], unverified: [] };
  if (!key || !proposal?.ops?.length) return out;
  const tasks = planOpVerification(proposal.ops, trip);
  if (!tasks.length) return out;
  emit?.({ type: 'beat', note: 'checking the stops are real' });

  const worker = async (task) => {
    const spec = SPECS[task.kind];
    const hit = await findPlace(key, { name: task.name, near: task.near, spec, searchImpl });
    if (!hit) {
      task.target.verified = false;
      out.unverified.push({ kind: task.kind, name: task.name });
      return;
    }
    const was = task.name;
    if (task.kind === 'fuel') {
      const moved = milesBetween(task.near, hit);
      task.target.name = hit.name || task.target.name;
      task.target.lat = hit.lat;
      task.target.lng = hit.lng;
      task.target.placeId = hit.id;
      task.target.verified = 'google';
      if (moved > 0.05 || nameOverlap(was, hit.name) < 0.5) out.corrected.push({ kind: task.kind, was, now: hit.name, mi: moved });
    } else {
      task.target.name = hit.name || task.target.name;
      task.target.where = hit.detail || task.target.where;
      task.target.placeId = hit.id;
      task.target.verified = 'google';
      if (nameOverlap(was, hit.name) < 0.9) out.corrected.push({ kind: task.kind, was, now: hit.name, mi: 0 });
    }
  };

  await pool(tasks, worker, { deadline, maxLookups });
  return out;
}

// One line the rider actually reads, appended to the optimizer's answer.
export function describeVerification({ corrected = [], unverified = [] }) {
  const bits = [];
  for (const c of corrected) {
    bits.push(c.mi >= 0.1
      ? `moved the ${SPECS[c.kind].label} to ${c.now} (${c.mi.toFixed(1)} mi from the pin)`
      : `matched the ${SPECS[c.kind].label} to ${c.now}`);
  }
  for (const u of unverified) bits.push(`could not find a real ${SPECS[u.kind].label} for “${u.name}” — flagged unverified`);
  if (!bits.length) return '';
  return `Place check: ${bits.join('; ')}.`;
}

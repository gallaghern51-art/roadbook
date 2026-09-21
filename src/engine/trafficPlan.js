// What the day will actually cost in traffic, for the departure it is planned
// from — not for right now.
//
// Roadbook's planned times come from Valhalla motorcycle costing: honest about
// the ROAD, and free-flowing by construction. Measured on the owner's own
// corridor (eastern Long Island → NYC, Sep 20 2026) the same 104 miles read
// 129 min free-flow against 154 min in live traffic: 20% under, and 20% of a
// touring day is an hour of daylight.
//
// The fix is not "show current traffic" — a trip six weeks out has no current
// traffic worth reading. It is to ask about the DEPARTURE: Google's Routes API
// answers a future `departureTime` with predicted traffic for that moment, so
// a Saturday 9 AM start and a Sunday 5 PM start get different answers, which is
// the thing a planner is for.
//
// Cost discipline: TRAFFIC_AWARE bills as the Pro SKU, so this is ONE call for
// the day the rider is looking at, cached per departure and per route for the
// life of the page. Nothing here runs for a day nobody opened.

import { tripRoutePrefs } from './tripEngine.js';
import { trafficEta } from './routing.js';

/**
 * The day's departure as a real instant.
 *
 * `day.date` is a calendar date and `day.depart` a wall clock, both in the
 * TRIP's timezone — which is not necessarily the browser's. `meta.utcOffset`
 * carries it when the rider has set one (the same field .ics export uses);
 * without it the browser's own zone is the best guess available, and being an
 * hour out only shifts which traffic pattern is quoted, never the miles.
 */
export function departureAt(trip, day) {
  if (!day?.date) return null;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(day.depart ?? '').trim());
  let hour = m ? Number(m[1]) : 9;
  const min = m ? Number(m[2]) : 0;
  if (m?.[3]) {
    const pm = /PM/i.test(m[3]);
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const offset = trip?.meta?.utcOffset;
  if (Number.isFinite(offset)) {
    // an explicit trip offset: build the instant from UTC so the answer does
    // not depend on where the rider happens to be sitting while planning
    const [y, mo, d] = day.date.split('-').map(Number);
    return new Date(Date.UTC(y, mo - 1, d, hour - offset, min));
  }
  const local = new Date(`${day.date}T00:00:00`);
  if (Number.isNaN(local.getTime())) return null;
  local.setHours(hour, min, 0, 0);
  return local;
}

// Google rejects a departure in the past, and a prediction for a departure
// already under way is not what a planning screen is asking about either.
// A minute of slack absorbs the clock ticking between render and request.
export const isFutureDeparture = (at) => at instanceof Date && at.getTime() > Date.now() + 60_000;

// The cache is PERSISTED, which matters much more now that the trip overview
// sweeps every future day: without it, reopening the overview on an eleven-day
// trip re-bought eleven Pro-SKU answers that had not changed.
//
// How long an answer keeps is a property of how far out the departure is. A
// prediction for next Tuesday is a typical-traffic pattern and is the same
// tomorrow; a prediction for this afternoon firms up as the afternoon
// approaches, and is worth re-asking.
const STORE = 'moto.trafficPlan.v1';
const ttlFor = (at) => {
  const out = at.getTime() - Date.now();
  if (out > 48 * 3_600_000) return 24 * 3_600_000;
  if (out > 6 * 3_600_000) return 4 * 3_600_000;
  return 15 * 60_000;
};

const cache = new Map(loadStore());
function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '[]');
    if (!Array.isArray(raw)) return [];
    // a stored entry carries its own expiry; drop what has run out on the way in
    return raw
      .filter((e) => Array.isArray(e) && e[1]?.until > Date.now())
      .map(([k, e]) => [k, { ...e, value: { ...e.value, at: new Date(e.value.at) } }]);
  } catch { return []; }
}
function saveStore() {
  try {
    localStorage.setItem(STORE, JSON.stringify(
      [...cache.entries()]
        .filter(([, e]) => e.until > Date.now())
        .slice(-200)
        .map(([k, e]) => [k, { until: e.until, value: { ...e.value, at: e.value.at.toISOString() } }]),
    ));
  } catch { /* storage full — the in-memory cache still stands */ }
}

const keyFor = (day, at, prefs) => [
  at.toISOString().slice(0, 16),
  prefs.avoidTolls ? 'no-tolls' : 'tolls-ok',
  (day.waypoints ?? []).filter((w) => Number.isFinite(w.lat)).map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';'),
].join('|');

/** Test seam: the cache outlives the page now, which a check script must be able to clear. */
export function clearTrafficPlanCache() {
  cache.clear();
  try { localStorage.removeItem(STORE); } catch { /* nothing stored */ }
}

/**
 * Predicted traffic for this day's planned departure.
 * @returns {Promise<{minutes:number, miles:number, at:Date, toll?:object}>}
 * @throws when there is no future departure to ask about, or Google is not
 *   configured — both of which are silence on the panel, never an error.
 */
export async function dayTrafficEta(trip, day, pace = 1) {
  const wps = (day?.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (wps.length < 2) throw new Error('the day has no route to measure');
  const at = departureAt(trip, day);
  if (!isFutureDeparture(at)) throw new Error('departure is not in the future');

  const prefs = tripRoutePrefs(trip);
  const key = keyFor(day, at, prefs);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const r = await trafficEta(wps[0], wps.slice(1), pace, {
    avoidTolls: prefs.avoidTolls,
    departureTime: at.toISOString(),
  });
  const value = { minutes: r.seconds / 60, miles: r.miles, at, ...(r.toll ? { toll: r.toll } : {}) };
  cache.set(key, { until: Date.now() + ttlFor(at), value });
  saveStore();
  return value;
}

/** Is this day worth asking about at all? Cheap, synchronous, no network. */
export const dayIsAskable = (trip, day) => (
  isFutureDeparture(departureAt(trip, day))
  && (day?.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng)).length >= 2
);

/** Already answered and still fresh — a cache read, never a call. */
export function cachedDayTraffic(trip, day) {
  if (!dayIsAskable(trip, day)) return null;
  const at = departureAt(trip, day);
  const hit = cache.get(keyFor(day, at, tripRoutePrefs(trip)));
  return hit && hit.until > Date.now() ? hit.value : null;
}

/**
 * Every day of the trip still ahead, measured ONE AT A TIME.
 *
 * Sequential is not politeness here, it is the whole cost story: the overview
 * shows eleven days at once, and eleven simultaneous TRAFFIC_AWARE calls are
 * eleven Pro-SKU answers bought in a burst — with a persisted cache and a
 * sweep that stops the moment the panel closes, an overview costs the days
 * that have actually changed and nothing else.
 *
 * @param {(dayId: string, value: object|null) => void} onDay  each answer as it lands
 */
export async function sweepTripTraffic(trip, pace = 1, { signal, onDay } = {}) {
  for (const day of trip?.days ?? []) {
    if (signal?.aborted) return;
    if (!dayIsAskable(trip, day)) { onDay?.(day.id, null); continue; }
    try {
      const value = await dayTrafficEta(trip, day, pace);
      if (signal?.aborted) return;
      onDay?.(day.id, value);
    } catch {
      if (signal?.aborted) return;
      onDay?.(day.id, null); // unreachable, unconfigured, or nothing to ask
    }
  }
}

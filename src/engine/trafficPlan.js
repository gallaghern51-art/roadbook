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

const cache = new Map();
const TTL_MS = 10 * 60_000;
const keyFor = (day, at, prefs) => [
  at.toISOString().slice(0, 16),
  prefs.avoidTolls ? 'no-tolls' : 'tolls-ok',
  (day.waypoints ?? []).filter((w) => Number.isFinite(w.lat)).map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';'),
].join('|');

/** Test seam: the cache is page-lifetime state, which a check script must be able to clear. */
export function clearTrafficPlanCache() { cache.clear(); }

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
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const r = await trafficEta(wps[0], wps.slice(1), pace, {
    avoidTolls: prefs.avoidTolls,
    departureTime: at.toISOString(),
  });
  const value = { minutes: r.seconds / 60, miles: r.miles, at, ...(r.toll ? { toll: r.toll } : {}) };
  cache.set(key, { at: Date.now(), value });
  return value;
}

// Predicted traffic for a planned departure (Sep 20, 2026).
//
// Owner: "show me the traffic time on the planning screen too", after finding
// Roadbook "much quicker on time compared to google maps" riding back from
// eastern Long Island.
//
// The numbers below are MEASURED against the deployed Routes function, same
// origin and destination (40.9634,-72.1848 → 40.7128,-74.0060, 104.3 mi):
//
//   Valhalla free-flow (what the plan showed)   129 min
//   Wednesday 03:00 ET                          117 min
//   traffic right now                           134 min
//   Sunday 17:00 ET                             166 min
//   Tuesday 09:00 ET                            175 min
//
// A 58-minute spread on one road, decided entirely by when you leave. That is
// why this asks about the DEPARTURE rather than about now: a trip six weeks
// out has no current traffic worth reading.
//
// Run: node scripts/traffic-plan-check.mjs

import { departureAt, isFutureDeparture, dayTrafficEta, clearTrafficPlanCache } from '../src/engine/trafficPlan.js';
import { resetRouterBackoff } from '../src/engine/routing.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dayOf = (date, depart, wps = 2) => ({
  id: 'd1',
  date,
  depart,
  waypoints: [
    { id: 'a', lat: 40.9634, lng: -72.1848 },
    { id: 'b', lat: 40.7128, lng: -74.0060 },
    { id: 'c', lat: 40.6, lng: -74.2 },
  ].slice(0, wps),
});
const tripWith = (meta = {}) => ({ meta: { routePrefs: { style: 'touring', avoidTolls: false }, ...meta }, days: [] });

console.log('\nthe departure, as a real instant');
{
  const at = departureAt(tripWith({ utcOffset: -4 }), dayOf('2026-09-22', '9:00 AM'));
  check('a trip offset builds the instant from UTC, not from where the rider is sitting',
    at.toISOString() === '2026-09-22T13:00:00.000Z', at.toISOString());
  const pm = departureAt(tripWith({ utcOffset: -4 }), dayOf('2026-09-27', '5:00 PM'));
  check('PM is afternoon', pm.toISOString() === '2026-09-27T21:00:00.000Z', pm.toISOString());
  const noon = departureAt(tripWith({ utcOffset: 0 }), dayOf('2026-09-22', '12:00 PM'));
  check('12 PM is noon, not midnight', noon.toISOString() === '2026-09-22T12:00:00.000Z', noon.toISOString());
  const mid = departureAt(tripWith({ utcOffset: 0 }), dayOf('2026-09-22', '12:30 AM'));
  check('12:30 AM is after midnight', mid.toISOString() === '2026-09-22T00:30:00.000Z', mid.toISOString());
  const local = departureAt(tripWith(), dayOf('2026-09-22', '9:00 AM'));
  check('no trip offset falls back to the browser zone rather than failing',
    local instanceof Date && local.getHours() === 9, String(local));
  check('a day with no date has no departure', departureAt(tripWith(), { depart: '9:00 AM' }) === null);
  const bare = departureAt(tripWith({ utcOffset: 0 }), { date: '2026-09-22' });
  check('a day with no depart time assumes 9 AM rather than midnight',
    bare.toISOString() === '2026-09-22T09:00:00.000Z', bare.toISOString());
}

console.log('\nonly a departure that has not happened');
{
  check('a past departure is not askable', !isFutureDeparture(new Date(Date.now() - 60_000)));
  check('a departure a minute out is not askable either — the clock ticks between render and request',
    !isFutureDeparture(new Date(Date.now() + 30_000)));
  check('an hour out is askable', isFutureDeparture(new Date(Date.now() + 3_600_000)));
  check('a non-date is not askable', !isFutureDeparture('tomorrow'));
}

// ---- the call ----
const future = () => {
  const d = new Date(Date.now() + 36 * 3_600_000);
  return d.toISOString().slice(0, 10);
};
let calls = [];
const mock = (durationSeconds = 175 * 60) => async (url, init) => {
  calls.push(JSON.parse(init.body));
  return {
    ok: true,
    status: 200,
    json: async () => ({ geometry: [[-72.18, 40.96], [-74.0, 40.71]], distanceMeters: 167863, durationSeconds }),
  };
};

console.log('\nwhat gets asked');
globalThis.fetch = mock();
resetRouterBackoff();
clearTrafficPlanCache();
calls = [];
const trip = tripWith({ utcOffset: -4, pace: 1 });
const day = dayOf(future(), '9:00 AM');
const r = await dayTrafficEta(trip, day, 1);
check('a future departure is measured', Math.round(r.minutes) === 175, `${r.minutes.toFixed(0)} min`);
check('the miles come back too', Math.round(r.miles) === 104, `${r.miles.toFixed(1)}`);
check('one call', calls.length === 1, `${calls.length}`);
check('it carries a departureTime', typeof calls[0].departureTime === 'string', JSON.stringify(calls[0].departureTime));
check('…which is in the future', new Date(calls[0].departureTime).getTime() > Date.now());
check('…and is the DAY\'S departure, not now',
  calls[0].departureTime.startsWith(future()), calls[0].departureTime);
check('it is tagged as an ETA ask, never a route replacement', calls[0].purpose === 'eta');
check('the first stop is the origin and the rest are waypoints',
  calls[0].origin.lat === 40.9634 && calls[0].waypoints.length === 1,
  `origin ${calls[0].origin.lat}, ${calls[0].waypoints.length} waypoint(s)`);
{
  // a day with a stop in the middle must send the middle stop too, or the
  // prediction describes a road the rider is not riding
  clearTrafficPlanCache();
  const before = calls.length;
  await dayTrafficEta(trip, dayOf(future(), '9:00 AM', 3), 1);
  const three = calls[calls.length - 1];
  check('every stop of the day rides along',
    calls.length === before + 1 && three.waypoints.length === 2,
    `${three.waypoints.length} waypoint(s)`);
}

console.log('\nthe pace the group actually rides');
clearTrafficPlanCache();
calls = [];
const paced = await dayTrafficEta(trip, day, 1.15);
check('group pace multiplies the predicted clock too',
  Math.abs(paced.minutes - 175 * 1.15) < 0.5, `${paced.minutes.toFixed(1)}`);

console.log('\ncost discipline — TRAFFIC_AWARE is the Pro SKU');
clearTrafficPlanCache();
calls = [];
await dayTrafficEta(trip, day, 1);
await dayTrafficEta(trip, day, 1);
await dayTrafficEta(trip, day, 1);
check('the same day asked three times costs ONE call', calls.length === 1, `${calls.length}`);

calls = [];
await dayTrafficEta(trip, { ...day, depart: '5:00 PM' }, 1);
check('a different departure is a different question', calls.length === 1, `${calls.length}`);

calls = [];
await dayTrafficEta(trip, dayOf(future(), '9:00 AM', 3), 1);
check('a stop added to the day re-asks', calls.length === 1, `${calls.length}`);

calls = [];
await dayTrafficEta({ ...trip, meta: { ...trip.meta, routePrefs: { style: 'touring', avoidTolls: true } } }, day, 1);
check('the toll rule rides into the request so the answer matches it',
  calls.length === 1 && calls[0].avoidTolls === true, JSON.stringify(calls[0]?.avoidTolls));

console.log('\nsilence, not errors');
clearTrafficPlanCache();
let threw = false;
try { await dayTrafficEta(trip, dayOf('2020-01-01', '9:00 AM'), 1); } catch { threw = true; }
check('a day in the past is refused before any call is made', threw);

threw = false;
calls = [];
try { await dayTrafficEta(trip, dayOf(future(), '9:00 AM', 1), 1); } catch { threw = true; }
check('a day with one waypoint has no route to measure', threw && calls.length === 0);

globalThis.fetch = async () => ({ ok: false, status: 501, json: async () => ({ error: 'no key' }) });
resetRouterBackoff();
clearTrafficPlanCache();
threw = false;
try { await dayTrafficEta(trip, dayOf(future(), '9:00 AM'), 1); } catch { threw = true; }
check('a deploy with no Google key throws, so the panel can simply say nothing', threw);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

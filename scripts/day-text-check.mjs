// A day's description tracks its route (Aug 15, 2026).
//
// Field report: the Saturday of the Sturgis trip had its route changed and the
// paragraph under the title kept describing the old one — "US-212 to the WY-296
// junction, Chief Joseph…" on a day that no longer rode it. day.summary is
// authored prose; no op touched it, and until now the panel had no input for it
// at all, so the text could only ever be wrong.
//
// The fix is a stamp, not a guess: writing a summary records the route it was
// written against (day.summaryFor = routeFingerprint(day)), and the first route
// edit on an unstamped day records the route it HAD, so drift is provable
// instead of suspected. This checks the whole state machine.
//
// Run: node scripts/day-text-check.mjs

import { applyOps } from '../src/engine/ops.js';
import { routeFingerprint, summaryIsStale } from '../src/engine/tripEngine.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const mkTrip = (patch = {}) => ({
  meta: { title: 'T', startDate: '2026-08-15' },
  days: [
    {
      id: 'd1',
      date: '2026-08-15', dow: 'SAT',
      title: 'Red Lodge → Beartooth → Great Falls',
      summary: 'US-212 to the WY-296 junction, Chief Joseph down to WY-120, then 285 miles of two-lane to Great Falls.',
      waypoints: [
        { id: 'a', name: 'Red Lodge, MT', lat: 45.1861, lng: -109.2468, kind: 'start' },
        { id: 'b', name: 'Beartooth Pass summit', lat: 44.9700, lng: -109.4665, kind: 'photo' },
        { id: 'c', name: 'Great Falls, MT', lat: 47.5053, lng: -111.3008, kind: 'end' },
      ],
      gates: [], meals: [], photos: [], modules: [],
      ...patch,
    },
    {
      id: 'd2',
      date: '2026-08-16', dow: 'SUN',
      title: 'Great Falls → Missoula',
      summary: 'Home over Rogers Pass.',
      waypoints: [
        { id: 'x', name: 'Great Falls, MT', lat: 47.5053, lng: -111.3008, kind: 'start' },
        { id: 'y', name: 'Missoula, MT', lat: 46.8721, lng: -113.9940, kind: 'end' },
      ],
      gates: [], meals: [], photos: [], modules: [],
    },
  ],
});

const run = (trip, ops) => {
  const { trip: next, errors } = applyOps(trip, ops);
  if (errors.length) console.log(`    ! ${errors.join('; ')}`);
  return next;
};
const day = (t, id) => t.days.find((d) => d.id === id);

console.log('\nFingerprint');
{
  const t = mkTrip();
  const d = day(t, 'd1');
  check('a day with no stamp never reads stale', !summaryIsStale(d));

  const moved = structuredClone(d);
  moved.waypoints[1].lat += 0.0001; // ~11 m — a marker nudged in a parking lot
  check('a sub-100 m nudge is the same route', routeFingerprint(moved) === routeFingerprint(d));

  const relocated = structuredClone(d);
  relocated.waypoints[1].lat += 0.05; // ~3.5 mi down the road
  check('a real relocation is a new route', routeFingerprint(relocated) !== routeFingerprint(d));

  const renamed = structuredClone(d);
  renamed.waypoints[1].name = 'Rock Creek Vista Point';
  check('a rename is a new route (the prose names stops)', routeFingerprint(renamed) !== routeFingerprint(d));

  const reordered = structuredClone(d);
  reordered.waypoints = [d.waypoints[0], d.waypoints[2], d.waypoints[1]];
  check('reordering is a new route', routeFingerprint(reordered) !== routeFingerprint(d));
}

console.log('\nRoute edits flag the description');
{
  const base = mkTrip();
  const cases = [
    ['add_waypoint', { op: 'add_waypoint', dayId: 'd1', index: 2, waypoint: { name: 'Belfry, MT', lat: 45.1461, lng: -109.0154 } }],
    ['remove_waypoint', { op: 'remove_waypoint', dayId: 'd1', waypointId: 'b' }],
    ['reorder_waypoints', { op: 'reorder_waypoints', dayId: 'd1', waypointIds: ['a', 'c', 'b'] }],
    ['update_waypoint (moved)', { op: 'update_waypoint', dayId: 'd1', waypointId: 'b', patch: { lat: 44.85, lng: -109.6 } }],
    ['update_waypoint (renamed)', { op: 'update_waypoint', dayId: 'd1', waypointId: 'b', patch: { name: 'Dead Indian Pass' } }],
  ];
  for (const [label, op] of cases) {
    const t = run(base, [op]);
    check(`${label} → stale`, summaryIsStale(day(t, 'd1')), 'flag did not fire');
  }

  const dwell = run(base, [{ op: 'update_waypoint', dayId: 'd1', waypointId: 'b', patch: { dwell: 25 } }]);
  check('a dwell edit is not a route change', !summaryIsStale(day(dwell, 'd1')));

  const timing = run(base, [{ op: 'set_day_field', dayId: 'd1', field: 'depart', value: '7:30 AM' }]);
  check('a depart edit is not a route change', !summaryIsStale(day(timing, 'd1')));
}

console.log('\nMoving a stop between days flags both');
{
  const t = run(mkTrip(), [{ op: 'move_waypoint', fromDayId: 'd1', toDayId: 'd2', waypointId: 'b', index: 1 }]);
  check('source day stale', summaryIsStale(day(t, 'd1')));
  check('destination day stale', summaryIsStale(day(t, 'd2')));
}

console.log('\nClearing the flag');
{
  const edited = run(mkTrip(), [{ op: 'remove_waypoint', dayId: 'd1', waypointId: 'b' }]);
  check('starts stale', summaryIsStale(day(edited, 'd1')));

  const rewritten = run(edited, [{ op: 'set_day_field', dayId: 'd1', field: 'summary', value: 'Straight up US-89 to Great Falls — the pass day is gone, and with it the only reason to leave at 8:30.' }]);
  check('rewriting clears it', !summaryIsStale(day(rewritten, 'd1')));

  // "Still accurate": same text, new stamp — the rider's judgement is the input
  const kept = run(edited, [{ op: 'set_day_field', dayId: 'd1', field: 'summary', value: day(edited, 'd1').summary }]);
  check('"still accurate" clears it without changing the words', !summaryIsStale(day(kept, 'd1')) && kept.days[0].summary === edited.days[0].summary);

  const again = run(rewritten, [{ op: 'remove_waypoint', dayId: 'd1', waypointId: 'c' }]);
  check('the next route edit flags it again', summaryIsStale(day(again, 'd1')));
}

console.log('\nEdge cases');
{
  const blank = run(mkTrip({ summary: '' }), [{ op: 'remove_waypoint', dayId: 'd1', waypointId: 'b' }]);
  check('a day with no description never nags', !summaryIsStale(day(blank, 'd1')));

  const untouched = run(mkTrip(), [{ op: 'remove_waypoint', dayId: 'd1', waypointId: 'b' }]);
  check('a day nobody edited stays quiet', !summaryIsStale(day(untouched, 'd2')));

  // the stamp records the PRE-edit route, so one edit is enough to prove drift
  const t = mkTrip();
  const before = routeFingerprint(day(t, 'd1'));
  const after = run(t, [{ op: 'add_waypoint', dayId: 'd1', index: 2, waypoint: { name: 'Belfry, MT', lat: 45.1461, lng: -109.0154 } }]);
  check('the stamp is the route the words were written for', day(after, 'd1').summaryFor === before);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);

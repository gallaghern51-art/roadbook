// Gate integrity across waypoint ops (Aug 12, 2026).
//
// A gate is "be at STOP by TIME" — a promise about a waypoint. Before this
// check's fixes, removing the waypoint left the gate ORPHANED: still stored,
// half-rendered in the editor, but silently absent from feasibility grading
// and the Ride Mode gate chip. The hard constraint evaporated without a word.
//
// Run: node scripts/gate-integrity-check.mjs

import { applyOps } from '../src/engine/ops.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const mkTrip = () => ({
  meta: { title: 'T', startDate: '2026-08-12' },
  days: [
    {
      id: 'd1',
      date: '2026-08-12',
      waypoints: [
        { id: 'a', name: 'Start', lat: 44.0, lng: -103.6, kind: 'start' },
        { id: 'b', name: 'Needles Hwy entry', lat: 44.1, lng: -103.6, kind: 'via' },
        { id: 'c', name: 'End', lat: 44.2, lng: -103.6, kind: 'end' },
      ],
      gates: [
        { label: 'Needles entry', by: '9:05 AM', waypointId: 'b' },
        { label: 'Day end', by: '6:00 PM', waypointId: 'c' },
      ],
    },
    { id: 'd2', date: '2026-08-13', waypoints: [{ id: 'x', name: 'X', lat: 44.3, lng: -103.6, kind: 'start' }], gates: [] },
  ],
});

console.log('remove_waypoint:');
{
  const { trip: t, errors } = applyOps(mkTrip(), [{ op: 'remove_waypoint', dayId: 'd1', waypointId: 'b' }]);
  check('op applied clean', errors.length === 0, errors.join('; '));
  check('the stop is gone', !t.days[0].waypoints.some((w) => w.id === 'b'));
  check('its gate goes with it', !t.days[0].gates.some((g) => g.waypointId === 'b'),
    JSON.stringify(t.days[0].gates));
  check('gates on other stops survive', t.days[0].gates.some((g) => g.waypointId === 'c'));
}

console.log('move_waypoint (cross-day):');
{
  const { trip: t, errors } = applyOps(mkTrip(), [{ op: 'move_waypoint', fromDayId: 'd1', toDayId: 'd2', waypointId: 'b', index: 1 }]);
  check('op applied clean', errors.length === 0, errors.join('; '));
  check('the stop moved days', t.days[1].waypoints.some((w) => w.id === 'b'));
  check('its gate travelled with it', t.days[1].gates.some((g) => g.waypointId === 'b'),
    JSON.stringify(t.days[1].gates));
  check('the source day no longer holds it', !t.days[0].gates.some((g) => g.waypointId === 'b'));
  check('unrelated gates stay put', t.days[0].gates.some((g) => g.waypointId === 'c'));
}

console.log('a day with no gates array:');
{
  const t0 = mkTrip();
  delete t0.days[0].gates;
  const { trip: t, errors } = applyOps(t0, [{ op: 'remove_waypoint', dayId: 'd1', waypointId: 'b' }]);
  check('op applied clean', errors.length === 0, errors.join('; '));
  check('remove still works', !t.days[0].waypoints.some((w) => w.id === 'b'));
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

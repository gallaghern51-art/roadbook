// Route-drag / add-a-stop insertion checks.
//
// Owner request (Sep 7, 2026): "a user can grab a point on the route and drag
// to fix that… the engine needs to align that point with whatever leg that
// point is touching so it changes the right portion of route and gets added in
// right spot on the linear flow of the ride."
//
// The insertion index is the whole feature. Dropping a via in the wrong slot
// does not just fail to fix the route — it sends the day through the new point
// at the wrong time, which reorders the ride.
//
// `bestInsertIndex` answers "which pair of stops is this cheapest between" in
// STRAIGHT LINES. That has no idea what the road does, so on any day that
// doubles back it can put a point from the return leg into the outbound one.
// `insertIndexAtAlong` reads the position off the routed line instead, which
// is exactly what a rider hands us when they grab that line.

import assert from 'node:assert/strict';
import {
  insertIndexAtAlong, insertIndexOnRoute, alongOnRoute, bestInsertIndex, chainCumMiles,
} from '../src/engine/tripEngine.js';

let pass = 0;
const ok = (label) => { pass++; console.log(`  ok  ${label}`); };

const wp = (name, lat, lng, kind = 'via') => ({ id: name, name, lat, lng, kind });
const chainOf = (pts) => pts.map(([lat, lng]) => ({ lat, lng }));

// ---------------------------------------------------------------------------
// 1. The reported shape: a leg whose ROAD detours away from the straight line.
//    Weehawken -> Nyack is one leg; the routed line swings east through
//    Manhattan and back. Dropping a via on the New Jersey side must land in
//    that one leg, at index 1, and must not append to the end of the day.
// ---------------------------------------------------------------------------
{
  const days = [wp('Weehawken', 40.768, -74.0175, 'start'), wp('Nyack', 41.0912, -73.9182, 'end')];
  const chain = chainOf([
    [40.768, -74.0175], [40.762, -73.995], [40.757, -73.99], // into the tunnel
    [40.79, -73.97], [40.851, -73.947],                      // up Manhattan
    [40.878, -73.95], [41.0, -73.92], [41.0912, -73.9182],   // over the bridge, north
  ]);
  const drop = { lat: 40.86, lng: -73.99 }; // the NJ side of the river

  assert.equal(insertIndexOnRoute(days, chain, drop), 1);
  ok('a via dropped beside a detouring leg lands inside that leg');
  assert.notEqual(insertIndexOnRoute(days, chain, drop), days.length);
  ok('it is never appended after the day’s destination');
}

// ---------------------------------------------------------------------------
// 2. The case the straight-line splice gets WRONG. An out-and-back on two
//    parallel roads: the return road passes close to the outbound one, so by
//    straight-line cost a return-leg point looks like it belongs to the
//    outbound leg. Read along the route, it is unambiguous.
// ---------------------------------------------------------------------------
{
  const days = [wp('Home', 0, 0, 'start'), wp('Turnaround', 0, 3), wp('Home again', 0, 0.2, 'end')];
  const chain = chainOf([
    [0, 0], [0, 1], [0, 2], [0, 3],           // out along one road
    [0.5, 3], [0.5, 2], [0.5, 1], [0.5, 0.2], // back along a parallel road
    [0, 0.2],
  ]);
  const onReturn = { lat: 0.5, lng: 1.0 };

  const cum = chainCumMiles(chain);
  const hit = alongOnRoute(chain, onReturn, cum);
  assert.ok(hit && hit.off < 0.5, `grab should sit on the line, off=${hit?.off}`);
  ok('a point grabbed off the line reports ~zero distance from it');

  assert.equal(insertIndexAtAlong(days, chain, hit.along, cum), 2);
  ok('a grab on the return road inserts AFTER the turnaround');

  assert.equal(bestInsertIndex(days, onReturn), 1);
  ok('…and the straight-line splice gets that same point wrong (index 1)');
}

// ---------------------------------------------------------------------------
// 3. Order along the line is what decides — walking one route forward, the
//    index only ever climbs.
// ---------------------------------------------------------------------------
{
  const days = [
    wp('A', 0, 0, 'start'), wp('B', 0, 1), wp('C', 0, 2), wp('D', 0, 3, 'end'),
  ];
  const chain = chainOf([[0, 0], [0, 1], [0, 2], [0, 3]]);
  const cum = chainCumMiles(chain);
  const total = cum[cum.length - 1];

  const seen = [0.05, 0.2, 0.4, 0.5, 0.7, 0.95].map((f) => insertIndexAtAlong(days, chain, total * f, cum));
  assert.deepEqual(seen, [1, 1, 2, 2, 3, 3]);
  ok('slots advance monotonically from the start of the day to its end');
  assert.ok(seen.every((i) => i >= 1), 'nothing may be inserted before the day’s start');
  ok('nothing is ever inserted ahead of the day’s first stop');
}

// ---------------------------------------------------------------------------
// 4. Degradation. No geometry, a bad along, or a genuine off-route detour must
//    hand the decision back rather than answer confidently with nonsense.
// ---------------------------------------------------------------------------
{
  const days = [wp('A', 0, 0, 'start'), wp('B', 0, 1), wp('C', 0, 2, 'end')];
  const chain = chainOf([[0, 0], [0, 1], [0, 2]]);

  assert.equal(insertIndexOnRoute(days, null, { lat: 0, lng: 0.5 }), null);
  assert.equal(insertIndexOnRoute(days, [{ lat: 0, lng: 0 }], { lat: 0, lng: 0.5 }), null);
  ok('no routed geometry returns null, so the caller falls back');

  assert.equal(insertIndexOnRoute(days, chain, { lat: 3, lng: 0.5 }), null);
  ok('a point miles off the route is a detour, not a leg correction');

  assert.equal(insertIndexAtAlong(days, chain, NaN), null);
  assert.equal(insertIndexAtAlong(days, chain, undefined), null);
  assert.equal(insertIndexAtAlong([wp('only', 0, 0)], chain, 1), null);
  ok('a missing or unusable along-position returns null rather than index 0');

  assert.equal(alongOnRoute(null, { lat: 0, lng: 0 }), null);
  assert.equal(alongOnRoute(chain, null), null);
  ok('alongOnRoute answers null instead of throwing on missing input');
}

// ---------------------------------------------------------------------------
// 5. A stop added mid-day must not disturb the stops around it: the slice
//    before the index is unchanged and the slice after keeps its order.
// ---------------------------------------------------------------------------
{
  const days = [
    wp('Start', 0, 0, 'start'), wp('Fuel', 0, 1, 'fuel'),
    wp('Lunch', 0, 2, 'food'), wp('End', 0, 3, 'end'),
  ];
  const chain = chainOf([[0, 0], [0, 1], [0, 2], [0, 3]]);
  const cum = chainCumMiles(chain);
  const i = insertIndexAtAlong(days, chain, cum[cum.length - 1] * 0.4, cum);
  const after = [...days.slice(0, i), wp('Via 1', 0.01, 1.2), ...days.slice(i)];

  assert.deepEqual(after.map((w) => w.name), ['Start', 'Fuel', 'Via 1', 'Lunch', 'End']);
  ok('the day’s linear flow keeps every other stop in place and in order');
}

console.log(`\n${pass}/${pass} route drag insertion checks passed`);

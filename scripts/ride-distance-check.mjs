// Ride Mode mileage checks (Aug 16, 2026).
//
// Field report, riding I-90 Bozeman → Missoula: "it shows me it's ninety three
// miles away, but as I'm watching the mile markers, I've been stuck on ninety
// three miles for about two to three miles." The same ride's screenshots carry
// the other half: 193 mi at 9:20, 161 mi at 9:42 — 33 miles of readout in 22
// minutes, an indicated 90 mph on a road being ridden at 70.
//
// One cause for both. Distances were measured by projecting the bike onto the
// MANEUVER chain, which draws a single straight chord between two turns that
// can be a hundred miles apart. Where the road runs along that chord the
// readout races; where it crosses it — the long northward swing through Deer
// Lodge — the readout stops while the bike rides real miles.
//
// This file rides the corridor both ways: it asserts the old ruler fails the
// way the rider described, and that the geometry ruler tracks the road.
//
// Run: node scripts/ride-distance-check.mjs

import { chainCursor, haversineMiles } from '../src/engine/tripEngine.js';
import { stepAlongs, navAlongRoute } from '../src/engine/rideDistance.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- the real corridor, coarsely: I-90 west out of Bozeman ----
// Bozeman → Three Forks → Butte, then the long NORTH run up the Deer Lodge
// valley, then west again into Missoula. The Butte→Deer Lodge leg is close to
// square across the Bozeman→Missoula chord, which is where the readout froze.
const SHAPE = [
  { lat: 45.680, lng: -111.038 }, // Bozeman
  { lat: 45.812, lng: -111.330 },
  { lat: 45.892, lng: -111.552 }, // Three Forks
  { lat: 45.960, lng: -112.030 },
  { lat: 45.990, lng: -112.534 }, // Butte
  { lat: 46.140, lng: -112.640 }, // …turning north
  { lat: 46.398, lng: -112.732 }, // Deer Lodge
  { lat: 46.520, lng: -112.900 },
  { lat: 46.668, lng: -113.152 }, // Drummond
  { lat: 46.760, lng: -113.560 },
  { lat: 46.872, lng: -114.000 }, // Missoula
];

// densify to ~0.1 mi, the way OSRM geometry arrives
const chain = [];
for (let s = 0; s < SHAPE.length - 1; s++) {
  const a = SHAPE[s];
  const b = SHAPE[s + 1];
  const n = Math.max(1, Math.round(haversineMiles(a, b) / 0.1));
  for (let k = 0; k < n; k++) {
    chain.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lng: a.lng + ((b.lng - a.lng) * k) / n });
  }
}
chain.push(SHAPE[SHAPE.length - 1]);
const cum = [0];
for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));
const geom = { chain, cum };
const TOTAL = cum[cum.length - 1];

// The step list a router actually returns for this: get on the interstate,
// then ONE maneuver spanning the whole run, then the exit and the arrival.
const STEPS = [
  { ...SHAPE[0], dist: 0.6, sec: 70, type: 'depart', instr: 'Head west' },
  { lat: 45.6825, lng: -111.0495, dist: TOTAL - 1.6, sec: (TOTAL - 1.6) * 51.4, type: 'merge', instr: 'Merge onto I-90 W' },
  { lat: 46.8690, lng: -113.9820, dist: 1.0, sec: 90, type: 'off ramp', instr: 'Take exit 99 for Airway Blvd' },
  { ...SHAPE[SHAPE.length - 1], dist: 0, sec: 0, type: 'arrive', stop: 'Missoula', instr: 'Arrive: Missoula' },
];

console.log(`\nThe corridor: ${TOTAL.toFixed(1)} routed miles, ${chain.length} vertices, ${STEPS.length} maneuvers`);

// ---- the old ruler, kept here verbatim so the regression can't come back ----
// This is exactly what locateOnSteps did, cursor and all: project the bike onto
// the MANEUVER chain, then scale the step's ROAD distance by the fraction along
// its straight CHORD.
function chordRemaining(steps, pos, cursor) {
  const best = cursor.project(steps, pos, { heading: pos.heading });
  if (!best) return null;
  let rem = Math.max(0, (1 - best.f) * steps[best.i].dist);
  for (let j = best.i + 1; j < steps.length; j++) rem += steps[j].dist;
  return { rem, off: best.off };
}

// Ride a chain and report how the readout behaved per mile ridden: the worst
// run of miles with no movement, and the fastest and slowest indicated rates.
function ride(chn, cm, steps, ruler) {
  const total = cm[cm.length - 1];
  let prev = null;
  let stall = 0;
  let worstStall = 0;
  let stallAt = 0;
  let fastest = 0;
  let slowest = Infinity;
  let farthestOff = 0;
  let at = Date.now();
  const STEP = 0.25;
  for (let mi = 1; mi < total - 1.5; mi += STEP) {
    const i = Math.max(0, cm.findIndex((c) => c >= mi));
    const p = chn[i];
    const q = chn[Math.min(i + 1, chn.length - 1)];
    const heading = (Math.atan2((q.lng - p.lng) * Math.cos((p.lat * Math.PI) / 180), q.lat - p.lat) * 180) / Math.PI;
    at += 13000; // ~0.25 mi at 70 mph, inside the cursor's staleness window
    const r = ruler({ ...p, heading, speedMph: 70, at }, mi);
    farthestOff = Math.max(farthestOff, r.off ?? 0);
    if (prev != null) {
      const moved = prev - r.rem;
      if (moved < 0.05) { stall += STEP; if (stall > worstStall) { worstStall = stall; stallAt = mi; } } else stall = 0;
      fastest = Math.max(fastest, moved / STEP);
      slowest = Math.min(slowest, moved / STEP);
    }
    prev = r.rem;
  }
  return { worstStall, stallAt, fastest, slowest, farthestOff };
}

const alongs = stepAlongs(STEPS, geom);

console.log('\nManeuvers land on the road they belong to');
{
  check('every maneuver placed', alongs?.length === STEPS.length);
  check('in route order, never backwards', alongs.every((a, i) => i === 0 || a >= alongs[i - 1]),
    alongs.map((a) => a.toFixed(1)).join(' '));
  check('the depart is at the start', alongs[0] < 1);
  check('the exit is within a mile of the end', TOTAL - alongs[2] < 2.5,
    `exit at ${alongs[2].toFixed(1)} of ${TOTAL.toFixed(1)}`);
  check('the arrival closes the route', Math.abs(alongs[3] - TOTAL) < 0.2);
}

// ---- ride it and watch both rulers ----
console.log('\nRiding the corridor');
const cursor = chainCursor();
const oldRun = ride(chain, cum, STEPS, (pos) => chordRemaining(STEPS, pos, cursor));
const newRun = ride(chain, cum, STEPS, (pos, mi) => ({ rem: navAlongRoute(STEPS, alongs, mi, TOTAL, 0).remMi, off: 0 }));

console.log(`  chord ruler: ${oldRun.slowest.toFixed(2)}×–${oldRun.fastest.toFixed(2)}× real, bike measured up to ${oldRun.farthestOff.toFixed(1)} mi off its own "route"`);
console.log(`  geometry:    ${newRun.slowest.toFixed(2)}×–${newRun.fastest.toFixed(2)}× real`);

// The screenshots from the reported ride: 193 mi at 9:20, 161 mi at 9:42 — 33
// miles of readout in 22 minutes, an indicated 90 mph on a road ridden at 70.
check('the too-fast countdown reproduces, at the rate the screenshots show',
  oldRun.fastest > 1.2 && oldRun.fastest < 1.4,
  `${oldRun.fastest.toFixed(2)}× (the screenshots work out to ~1.27×)`);
// A ruler that runs 28% fast on one stretch has to run slow on another: the
// error is where the road leaves the chord, and it always comes back.
check('…and it runs correspondingly slow elsewhere, which is the stall',
  oldRun.slowest < 0.85, `slowest ${oldRun.slowest.toFixed(2)}× real`);
check('the maneuver chain is not the road — the bike measures miles off it',
  oldRun.farthestOff > 5, `${oldRun.farthestOff.toFixed(1)} mi`);

check('the geometry ruler never stalls', newRun.worstStall === 0,
  `${newRun.worstStall.toFixed(2)} mi near mile ${newRun.stallAt.toFixed(0)}`);
check('…and never runs fast or slow', newRun.fastest <= 1.02 && newRun.slowest >= 0.98,
  `${newRun.slowest.toFixed(3)}×–${newRun.fastest.toFixed(3)}×`);

// The corridor above is hand-drawn off a map and so is smoother than the road,
// which is why it runs 0.6× rather than stopping. This case isolates the
// mechanism at full strength: a stretch that leaves the straight line between
// its two maneuvers and comes back to it — a pass, a river bend, a detour
// around a lake. There the bike's foot on the chord doesn't just crawl, it
// stops and then walks BACKWARD, which is the readout freezing against the
// mile markers.
console.log('\nA stretch that leaves its own chord and returns: the readout stops dead');
{
  const dog = [
    { lat: 46.00, lng: -112.00 },
    { lat: 46.45, lng: -112.02 }, // away from the line…
    { lat: 46.00, lng: -112.04 }, // …and back to it: no chord progress at all
    { lat: 46.00, lng: -113.00 }, // then straight west again
  ];
  const dchain = [];
  for (let s = 0; s < dog.length - 1; s++) {
    const a = dog[s];
    const b = dog[s + 1];
    const n = Math.max(1, Math.round(haversineMiles(a, b) / 0.05));
    for (let k = 0; k < n; k++) dchain.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lng: a.lng + ((b.lng - a.lng) * k) / n });
  }
  dchain.push(dog[dog.length - 1]);
  const dcum = [0];
  for (let i = 1; i < dchain.length; i++) dcum.push(dcum[i - 1] + haversineMiles(dchain[i - 1], dchain[i]));
  const dtotal = dcum[dcum.length - 1];
  const dsteps = [
    { ...dog[0], dist: dtotal, sec: dtotal * 51.4, type: 'depart', instr: 'Continue on I-90 W' },
    { ...dog[dog.length - 1], dist: 0, sec: 0, type: 'arrive', stop: 'Missoula', instr: 'Arrive: Missoula' },
  ];
  const dalongs = stepAlongs(dsteps, { chain: dchain, cum: dcum });
  const dcur = chainCursor();
  const oldD = ride(dchain, dcum, dsteps, (pos) => chordRemaining(dsteps, pos, dcur));
  const newD = ride(dchain, dcum, dsteps, (pos, mi) => ({ rem: navAlongRoute(dsteps, dalongs, mi, dtotal, 0).remMi, off: 0 }));
  console.log(`  chord ruler: frozen for ${oldD.worstStall.toFixed(1)} mi of riding (from mile ${(oldD.stallAt - oldD.worstStall).toFixed(0)})`);
  console.log(`  geometry:    frozen for ${newD.worstStall.toFixed(1)} mi`);
  check('the chord ruler freezes for miles at a time — the reported bug',
    oldD.worstStall >= 2, `${oldD.worstStall.toFixed(1)} mi`);
  check('the geometry ruler keeps counting through it', newD.worstStall === 0,
    `${newD.worstStall.toFixed(2)} mi`);
}

console.log('\nWhat the numbers actually mean');
{
  const r = navAlongRoute(STEPS, alongs, 100, TOTAL, 0.01);
  check('miles left in the day = route length minus miles ridden',
    Math.abs(r.remMi - (TOTAL - 100)) < 0.01, `${r.remMi.toFixed(2)} vs ${(TOTAL - 100).toFixed(2)}`);
  check('miles to the next turn is the distance along the ROAD',
    Math.abs(r.toNext - (alongs[2] - 100)) < 0.01);
  check('a mile ridden is a mile off the clock', (() => {
    const a = navAlongRoute(STEPS, alongs, 100, TOTAL, 0);
    const b = navAlongRoute(STEPS, alongs, 101, TOTAL, 0);
    return Math.abs((a.remMi - b.remMi) - 1) < 0.001 && Math.abs((a.toNext - b.toNext) - 1) < 0.001;
  })());
  check('the leg runs to the arrival, not to the exit ramp',
    Math.abs(r.legMi - r.remMi) < 0.01 && r.legStop === 'Missoula');
  check('the next maneuver is the exit, with the arrival behind it',
    r.next.type === 'off ramp' && r.after?.type === 'arrive');
  check('times are prorated by distance, not by chord',
    r.remMin > 0 && Math.abs(r.remMin - ((TOTAL - 100) * 51.4 + 90) / 60) < 2,
    `${r.remMin.toFixed(1)} min`);
}

console.log('\nThe end of the route, and the degenerate cases');
{
  const end = navAlongRoute(STEPS, alongs, TOTAL, TOTAL, 0);
  check('nothing goes negative at the arrival', end.remMi === 0 && end.toNext >= 0 && end.legMi === 0);
  check('the last maneuver stays the arrival', end.next.type === 'arrive');
  check('no steps', navAlongRoute([], [], 10, 100) === null);
  check('no geometry', stepAlongs(STEPS, { chain: [], cum: [] }) === null);
  check('a zero-length route', stepAlongs(STEPS, { chain: [chain[0], chain[0]], cum: [0, 0] }) === null);
  check('a step list that is not on this geometry still yields a monotone ladder', (() => {
    const off = STEPS.map((s) => ({ ...s, lat: s.lat + 3, lng: s.lng + 3 }));
    const a = stepAlongs(off, geom);
    return a && a.every((x, i) => i === 0 || x >= a[i - 1]);
  })());
}

// A day that rides the same pavement twice must put each maneuver on the pass
// that reaches it — the out-and-back case the direction-aware projection exists
// for, here in the mileage ladder.
console.log('\nAn out-and-back rides the same road twice');
{
  const out = chain.slice(0, 400);
  const loop = [...out, ...out.slice(0, -1).reverse()];
  const lcum = [0];
  for (let i = 1; i < loop.length; i++) lcum.push(lcum[i - 1] + haversineMiles(loop[i - 1], loop[i]));
  const half = lcum[out.length - 1];
  const lsteps = [
    { ...loop[0], dist: half, sec: 2000, type: 'depart', instr: 'Head out' },
    { ...out[out.length - 1], dist: half, sec: 2000, type: 'turn', instr: 'Turn around' },
    { ...loop[0], dist: 0, sec: 0, type: 'arrive', stop: 'Home', instr: 'Arrive: Home' },
  ];
  const la = stepAlongs(lsteps, { chain: loop, cum: lcum });
  check('the turnaround is at the far end, not at the start',
    Math.abs(la[1] - half) < 0.3, `${la[1].toFixed(2)} vs ${half.toFixed(2)}`);
  check('the arrival is at the END of the loop, not back at mile 0',
    Math.abs(la[2] - lcum[lcum.length - 1]) < 0.3, `${la[2].toFixed(2)}`);
  const back = navAlongRoute(lsteps, la, half + 1, lcum[lcum.length - 1], 0);
  check('on the way home the miles left are the miles home',
    Math.abs(back.remMi - (half - 1)) < 0.05, `${back.remMi.toFixed(2)} vs ${(half - 1).toFixed(2)}`);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

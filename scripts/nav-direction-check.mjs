// Direction-aware projection + arrival-ring checks (Aug 12, 2026).
//
// Field problems these guard against, all caught on the Crazy Horse
// out-and-back: (1) the traveled-line dim split detaching from the puck,
// (2) nav "spinning around" — turn guidance and auto-arrival reading from
// the RETURN copy of a road the day rides twice, (3) "Arrived" declared
// while still riding 200 m out (the old flat 0.25 mi ring).
//
// Run: node scripts/nav-direction-check.mjs

import {
  projectOnChainDirected, chainCursor, haversineMiles,
} from '../src/engine/tripEngine.js';
import {
  createNav, navFix, navTarget, arriveRingMi, ARRIVE_MI, ARRIVE_PARKED_MI,
} from '../src/engine/rideNav.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- synthetic out-and-back corridor ----
// A straight N–S road ridden UP then back DOWN, the return copy offset one
// carriageway width (~16 m) east — the geometry OSRM hands back for any
// out-and-back day. 5 mi each way, vertices every ~0.035 mi.
const LNG_OUT = -103.6;
const LNG_BACK = -103.5998;
const LAT0 = 44.0;
const LAT1 = 44.0723; // ≈ 5 mi north
const STEP = 0.0005;
const chain = [];
for (let lat = LAT0; lat <= LAT1 + 1e-9; lat += STEP) chain.push({ lat, lng: LNG_OUT });
for (let lat = LAT1; lat >= LAT0 - 1e-9; lat -= STEP) chain.push({ lat, lng: LNG_BACK });
chain.push({ lat: LAT0, lng: LNG_BACK }); // close the return leg exactly (float stepping stops short)
const cum = [0];
for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));
const total = cum[cum.length - 1];
const apexMi = total / 2;
const NORTH = 0;
const SOUTH = 180;
// a fix drifted 3/4 of the way from the outbound copy toward the return copy
// — the worst realistic GPS noise, where plain nearest picks the wrong road
const drifted = (lat, extra = {}) => ({ lat, lng: LNG_OUT + 0.00015, at: 0, ...extra });

console.log('projectOnChainDirected:');
{
  const plain = projectOnChainDirected(chain, drifted(44.03), { cum });
  check('drifted fix with no heading lands on the RETURN copy (the ambiguity is real)',
    plain.along > apexMi, `along ${plain.along.toFixed(2)} vs apex ${apexMi.toFixed(2)}`);

  const out = projectOnChainDirected(chain, drifted(44.03), { heading: NORTH, cum });
  check('heading north keeps the same fix on the OUTBOUND copy',
    out.along < apexMi, `along ${out.along.toFixed(2)}`);
  check('raw off is the chosen segment\'s true distance (not the nearest\'s)',
    out.off > 0.005 && out.off < 0.012, `off ${out.off.toFixed(4)}`);

  const back = projectOnChainDirected(chain, drifted(44.03), { heading: SOUTH, cum });
  check('heading south matches the RETURN copy', back.along > apexMi, `along ${back.along.toFixed(2)}`);

  const held = projectOnChainDirected(chain, drifted(44.03), { nearMi: 2.0, cum });
  check('no heading (parked) + continuity memory stays on the outbound copy',
    held.along < apexMi, `along ${held.along.toFixed(2)}`);

  // near the apex both copies sit inside the continuity window — heading
  // must still separate them (this is where premature "passed target" fired)
  const nearApex = projectOnChainDirected(chain, drifted(44.0705), { heading: NORTH, nearMi: apexMi - 0.15, cum });
  check('0.12 mi short of the apex, heading north still reads OUTBOUND',
    nearApex.along < apexMi, `along ${nearApex.along.toFixed(2)} apex ${apexMi.toFixed(2)}`);
}

console.log('afterMi (stationary stop → which drive-by):');
{
  // a stop beside the corridor: the route approaches it twice
  const stop = { lat: 44.029, lng: LNG_OUT - 0.0002 };
  const first = projectOnChainDirected(chain, stop, { cum, afterMi: 0 });
  const outAlong = first.along;
  check('afterMi 0 picks the FIRST drive-by', outAlong < apexMi, `along ${outAlong.toFixed(2)}`);
  const next = projectOnChainDirected(chain, stop, { cum, afterMi: apexMi });
  check('afterMi past the apex picks the RETURN drive-by', next.along > apexMi, `along ${next.along.toFixed(2)}`);
  const last = projectOnChainDirected(chain, stop, { cum, afterMi: total - 0.5 });
  check('afterMi beyond every drive-by falls back to the LAST one',
    last.along > apexMi && last.along < total - 0.5, `along ${last.along.toFixed(2)}`);
}

console.log('chainCursor (fix-to-fix tracking):');
{
  // ride the full out-and-back at ~0.07 mi per fix with worst-case drift;
  // along must never rewind and never leap — the dim split, the puck snap,
  // and the passage measure all read this number
  const cur = chainCursor();
  let prev = null;
  let monotonic = true;
  let maxJump = 0;
  let t = 1000;
  for (let lat = LAT0; lat <= LAT1 - STEP; lat += 0.001) {
    const r = cur.project(chain, drifted(lat, { at: (t += 1000), speedMph: 55 }), { heading: NORTH, cum });
    if (prev != null) {
      if (r.along < prev - 0.02) monotonic = false;
      maxJump = Math.max(maxJump, Math.abs(r.along - prev));
    }
    prev = r.along;
  }
  check('outbound ride: along never rewinds', monotonic);
  check('outbound ride: no leap onto the return copy', maxJump < 0.2, `max jump ${maxJump.toFixed(2)} mi`);
  check('outbound ride ends short of the apex', prev < apexMi, `along ${prev.toFixed(2)}`);

  // park at the apex (heading gone), then depart south: the cursor must
  // cross onto the return copy — a real direction change is not noise
  const atApex = cur.project(chain, { lat: LAT1, lng: LNG_OUT + 0.0001, at: (t += 1000), speedMph: 0 }, { heading: null, cum });
  check('parked at the apex stays near the apex', Math.abs(atApex.along - apexMi) < 0.3, `along ${atApex.along.toFixed(2)}`);
  let south = null;
  for (let lat = LAT1 - 0.001; lat > LAT1 - 0.006; lat -= 0.001) {
    south = cur.project(chain, { lat, lng: LNG_BACK - 0.00015, at: (t += 1000), speedMph: 40, heading: SOUTH }, { heading: SOUTH, cum });
  }
  check('departing south picks up the RETURN copy', south.along > apexMi, `along ${south.along.toFixed(2)}`);

  // a cursor legitimately tracking the return copy that turns out to be the
  // wrong one (rider actually outbound) heals within 3 moving fixes
  const cur2 = chainCursor();
  let t2 = 1000;
  let locked = null;
  for (let k = 0; k < 2; k++) {
    locked = cur2.project(chain, { lat: 44.032 - k * 0.001, lng: LNG_BACK - 0.00005, at: (t2 += 1000), speedMph: 45 },
      { heading: SOUTH, cum });
  }
  check('cursor warmed on the RETURN copy (setup)', locked.along > apexMi, `along ${locked.along.toFixed(2)}`);
  let healed = null;
  for (let k = 1; k <= 3; k++) {
    healed = cur2.project(chain, drifted(44.03 + k * 0.001, { at: (t2 += 1000), speedMph: 50 }), { heading: NORTH, cum });
  }
  check('three heading-opposed fixes drop the memory and re-acquire OUTBOUND',
    healed.along < apexMi, `along ${healed.along.toFixed(2)}`);
}

console.log('shared start/end (a day that leaves from and returns to the lodging):');
{
  // parked at the cabin, drifted toward the RETURN side of the road: the
  // chain holds this point at along ≈ 0 AND along ≈ total. A cold cursor
  // with no heading must read "day not yet ridden" — the end-copy lock is
  // what ate a just-added mid-loop stop (field-caught: Deadwood on a Cozy
  // Cabin loop day).
  const parked = { lat: LAT0, lng: LNG_BACK - 0.00003, at: 1000, speedMph: 0 };
  const plain = projectOnChainDirected(chain, parked, { cum });
  check('the ambiguity is real: plain nearest reads the END copy',
    plain.along > apexMi, `along ${plain.along.toFixed(2)} of ${total.toFixed(2)}`);
  const cur = chainCursor();
  const cold = cur.project(chain, parked, { heading: null, cum });
  check('cold park locks the EARLIEST copy', cold.along < 0.1, `along ${cold.along.toFixed(2)}`);
  let t = 1000;
  let r = null;
  for (let k = 1; k <= 4; k++) {
    r = cur.project(chain, { lat: LAT0 + k * 0.001, lng: LNG_OUT + 0.00015, at: (t += 1000), speedMph: 45 }, { heading: NORTH, cum });
  }
  check('departing outbound rides the along up from zero', r.along > 0.1 && r.along < 1, `along ${r.along.toFixed(2)}`);
}

console.log('same-DIRECTION overlap (loop rides one stretch southbound twice):');
{
  // Field-caught at Deadwood: the morning ride out and the midnight return
  // traverse the same road in the SAME direction, so heading cannot separate
  // the copies. Cold acquisition must take the earliest aligned copy — the
  // late lock read "Day · 7 mi" at 11 AM with the whole day ahead.
  const A = -103.6;
  const B = -103.5998;
  const stick = [];
  for (let lat = 44.05; lat >= 44.0 - 1e-9; lat -= 0.0005) stick.push(lat);
  const loop = { chain: [], cum: null };
  for (const lat of stick) loop.chain.push({ lat, lng: A });          // copy 1: southbound
  loop.chain.push({ lat: 44.0, lng: -103.55 });                       // far detour east…
  loop.chain.push({ lat: 44.05, lng: -103.55 });                      // …and back north
  for (const lat of stick) loop.chain.push({ lat, lng: B });          // copy 2: southbound AGAIN
  loop.chain.push({ lat: 43.99, lng: B });                            // tail to the day's end
  const lcum = [0];
  for (let i = 1; i < loop.chain.length; i++) lcum.push(lcum[i - 1] + haversineMiles(loop.chain[i - 1], loop.chain[i]));
  const copy2Start = lcum[stick.length + 2];

  // moving south mid-stick, GPS drifted toward copy 2
  const mid = (k, t) => ({ lat: 44.03 - k * 0.001, lng: B - 0.00005, at: t, speedMph: 45 });
  const cur = chainCursor();
  let t = 1000;
  const cold = cur.project(loop.chain, mid(0, t), { heading: SOUTH, cum: lcum });
  check('cold MOVING acquisition takes the earliest aligned copy',
    cold.along < copy2Start, `along ${cold.along.toFixed(2)} vs copy2 at ${copy2Start.toFixed(2)}`);
  let r = null;
  for (let k = 1; k <= 4; k++) r = cur.project(loop.chain, mid(k, (t += 1000)), { heading: SOUTH, cum: lcum });
  check('and continuity holds it there while riding', r.along < copy2Start, `along ${r.along.toFixed(2)}`);
}

console.log('arrival ring (speed-tiered):');
{
  const mi = (d) => d / 69.17; // degrees latitude for d miles
  const wps = [
    { id: 'o', name: 'Origin', lat: 44.0, lng: -103.0 },
    { id: 'a', name: 'Stop A', lat: 44.2, lng: -103.0 },
    { id: 'z', name: 'End', lat: 44.5, lng: -103.0 },
  ];
  const at = (dMi, speedMph) => ({ lat: 44.2 - mi(dMi), lng: -103.0, speedMph });

  check('ring at speed is tight', arriveRingMi(40) === ARRIVE_MI && ARRIVE_MI <= 0.1);
  check('ring at parking pace is venue-wide', arriveRingMi(2) === ARRIVE_PARKED_MI);

  // the field complaint: riding 200 m (0.124 mi) out must NOT read arrived
  let r = navFix(createNav(), wps, at(0.124, 40));
  check('riding past 200 m out does not latch', navTarget(r.nav, wps).id === 'a');

  r = navFix(createNav(), wps, at(0.124, 3));
  check('parked 200 m out (at the venue) latches', r.nav.visited.has('a'));

  r = navFix(createNav(), wps, at(0.07, 40));
  check('riding within ~110 m latches', r.nav.visited.has('a'));

  r = navFix(createNav(), wps, { lat: 44.5 - mi(0.05), lng: -103.0, speedMph: 40 });
  check('the final stop never proximity-latches', !r.nav.visited.has('z'));
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

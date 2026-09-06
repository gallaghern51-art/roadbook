// viewGate checks (Aug 15, 2026).
//
// Field report: "on ride mode the labels for stops shoot across the screen
// continuously — seems like it's trying to show them even if it's far away."
// Two causes, both of which viewGate has to catch:
//
//  1. MapLibre parks off-screen DOM markers in the margins instead of
//     removing them, so the edge clamp measured a stop 200 miles up the trip
//     at x = -700000px and slid it back inside the frame — every camera
//     settle, which under a chase camera is once a second.
//  2. A pitched nav camera projects ground BEYOND THE HORIZON back into the
//     top of the viewport, so screen bounds alone still admit stops that are
//     nowhere near the bike.
//
// The map here is a synthetic pinhole camera with MapLibre's geometry: a
// perspective divide for project, a ray/ground-plane intersection for
// unproject (including the mirrored answer you get for rays that never reach
// the ground — which is exactly the signal the round trip reads).
//
// Run: node scripts/map-vis-check.mjs

import { viewGate } from '../src/engine/mapVis.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const LAT0 = 44.35;   // Sturgis-ish
const LNG0 = -103.5;
const MI_PER_DEG_LAT = 69.17;
const MI_PER_DEG_LNG = MI_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);

// ground miles (east, north from the camera's look-at point) → lng/lat
const at = (east, north) => [LNG0 + east / MI_PER_DEG_LNG, LAT0 + north / MI_PER_DEG_LAT];

/**
 * A camera looking north, tilted `pitch` degrees off straight-down-the-nadir,
 * with its look-at point on the ground at (0,0) and the ground `hMi` miles
 * below it. `focal` is in px. Screen is w×h.
 */
function fakeMap({ pitch = 55, hMi = 0.25, w = 375, h = 700, focal = 900 } = {}) {
  const p = (pitch * Math.PI) / 180;
  // camera sits behind and above the look-at point
  const cam = { e: 0, n: -hMi * Math.tan(p), up: hMi };
  const fwd = { e: 0, n: Math.sin(p), up: -Math.cos(p) };
  const right = { e: 1, n: 0, up: 0 };
  const upv = { e: 0, n: Math.cos(p), up: Math.sin(p) };
  const dot = (a, b) => a.e * b.e + a.n * b.n + a.up * b.up;

  return {
    getContainer: () => ({ clientWidth: w, clientHeight: h }),
    project([lng, lat]) {
      const g = {
        e: (lng - LNG0) * MI_PER_DEG_LNG - cam.e,
        n: (lat - LAT0) * MI_PER_DEG_LAT - cam.n,
        up: -cam.up,
      };
      const depth = dot(g, fwd);
      // MapLibre's perspective divide mirrors points behind the camera into
      // the frame rather than rejecting them — mirror them here too.
      return {
        x: w / 2 + (dot(g, right) / depth) * focal,
        y: h / 2 - (dot(g, upv) / depth) * focal,
      };
    },
    unproject([x, y]) {
      const a = (x - w / 2) / focal;
      const b = (h / 2 - y) / focal;
      const dir = {
        e: fwd.e + a * right.e + b * upv.e,
        n: fwd.n + a * right.n + b * upv.n,
        up: fwd.up + a * right.up + b * upv.up,
      };
      // where the ray crosses the ground plane. A ray angled ABOVE the
      // horizon (dir.up >= 0) never does going forward, and the algebra hands
      // back the crossing BEHIND the camera — miles from the truth, which is
      // the whole tell.
      const t = -cam.up / dir.up;
      return {
        lng: LNG0 + (cam.e + t * dir.e) / MI_PER_DEG_LNG,
        lat: LAT0 + (cam.n + t * dir.n) / MI_PER_DEG_LAT,
      };
    },
  };
}

console.log('\nNav camera (pitch 55, chase framing)');
{
  const map = fakeMap();
  const gate = viewGate(map);

  const near = at(0, 0.15);
  check('a stop 0.15 mi up the road is visible', !!gate(near));

  const p = gate(near);
  const raw = map.project(near);
  check('the gate hands back the map\'s own screen point',
    !!p && Math.abs(p.x - raw.x) < 1e-6 && Math.abs(p.y - raw.y) < 1e-6);

  // The reported symptom: stops elsewhere in the day, hundreds of miles off,
  // measured by the edge clamp and dragged into the frame.
  for (const [e, n, what] of [[0, 8, '8 mi ahead'], [0, 200, '200 mi ahead'],
    [60, 30, '60 mi east / 30 north'], [-120, 200, '120 mi west / 200 north'],
    [0, -300, '300 mi behind']]) {
    const far = at(e, n);
    const sp = map.project(far);
    check(`${what} is rejected`, gate(far) === null,
      `projected to ${sp.x.toFixed(0)},${sp.y.toFixed(0)}`);
    check(`  …and it is the clamp's ${Math.round(Math.abs(sp.x - 187))}px overshoot that used to fire`,
      Math.abs(sp.x - 187) > 300 || sp.y < -100,
      `x ${sp.x.toFixed(0)} y ${sp.y.toFixed(0)} — expected it far outside the 375×700 frame`);
  }

  check('a stop far off to the side is rejected', gate(at(-25, 0.2)) === null);
  check('a stop just off the left edge is rejected', gate(at(-0.12, 0.05)) === null);
  check('pad admits a stop just outside the frame',
    !!viewGate(map, { pad: 80 })(at(-0.115, 0.05)));
}

console.log('\nThe horizon stays above the frame at every pitch MapLibre allows');
{
  // The reason screen bounds are the whole answer (see mapVis.js). Ground far
  // enough away converges on the horizon line, and at pitch ≤ 60 that line is
  // off the TOP of the frame — so distance alone can never fold a stop back
  // into view pretending to be nearby.
  for (const pitch of [0, 30, 55, 60]) {
    const map = fakeMap({ pitch });
    const gate = viewGate(map);
    const far = [50, 300, 2000].map((n) => map.project(at(0, n)));
    check(`pitch ${pitch}: distant ground never lands inside the frame`,
      far.every((p) => p.y < 0 || p.y > 700),
      far.map((p) => p.y.toFixed(0)).join(', '));
    check(`pitch ${pitch}: …and the gate rejects all of it`,
      [50, 300, 2000].every((n) => gate(at(0, n)) === null));
  }
}

console.log('\nOverview camera (pitch 0, whole day framed)');
{
  // fitBounds sets pitch 0; the gate must not start hiding the day's stops.
  const map = fakeMap({ pitch: 0, hMi: 40, focal: 900 });
  const gate = viewGate(map);
  check('a stop 5 mi out is visible', !!gate(at(0, 5)));
  check('a stop 12 mi out is visible', !!gate(at(3, -12)));
  check('a stop 60 mi out is rejected', gate(at(0, 60)) === null);
  check('nothing is rejected as "beyond the horizon" with no pitch',
    [1, 5, 9, -9, -3].every((n) => !!gate(at(0, n))));
}

console.log('\nRobustness');
{
  const map = fakeMap();
  const gate = viewGate(map);
  check('a bad coordinate is rejected, not thrown', gate([NaN, 44]) === null);
  check('object form works like tuple form',
    !!gate({ lng: at(0, 0.15)[0], lat: at(0, 0.15)[1] }));

  const zero = fakeMap({ w: 0, h: 0 });
  check('a zero-size container rejects everything', viewGate(zero)(at(0, 0.1)) === null);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

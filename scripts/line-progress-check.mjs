// Route-line gradient placement checks (Aug 14, 2026).
//
// Field problem this guards against, caught riding I-90 out of Sturgis toward
// Sheridan: the traveled/ahead split on the ride map sat well ahead of the
// puck and kept pulling away with every mile ("route marker keeps getting
// further from my marker"). MapLibre's `line-progress` is a fraction of the
// line's WEB-MERCATOR length — geojson-vt projects before it measures — so a
// ground-mile fraction points at the wrong place on any route that gains or
// loses latitude, by nothing at the ends of the line and by miles in the
// middle. These checks pin the gradient stops to the projected metric and
// keep the old ground-mile shortcut from creeping back.
//
// Run: node scripts/line-progress-check.mjs

import { haversineMiles, mercatorCum, lineProgressAt } from '../src/engine/tripEngine.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// geojson-vt's own projection, transcribed from the bundled source — the
// reference the map will measure with, independent of our implementation.
const projectX = (x) => x / 360 + 0.5;
const projectY = (y) => {
  const sin = Math.sin((y * Math.PI) / 180);
  const y2 = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y2 < 0 ? 0 : y2 > 1 ? 1 : y2;
};
const refProgress = (chain, upto) => {
  let acc = 0;
  const at = [0];
  for (let i = 1; i < chain.length; i++) {
    const dx = projectX(chain[i].lng) - projectX(chain[i - 1].lng);
    const dy = projectY(chain[i].lat) - projectY(chain[i - 1].lat);
    acc += Math.sqrt(dx * dx + dy * dy);
    at.push(acc);
  }
  return at[upto] / acc;
};

const densify = (pts, per = 200) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k < per; k++) {
      out.push({
        lat: pts[i].lat + ((pts[i + 1].lat - pts[i].lat) * k) / per,
        lng: pts[i].lng + ((pts[i + 1].lng - pts[i].lng) * k) / per,
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};
const groundCum = (chain) => {
  const cum = [0];
  for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));
  return cum;
};
// Where does a gradient stop actually land on the drawn line? Walk the
// projected metric to that fraction and report the point in ground miles —
// this is what the rider sees, and it must sit on the puck.
// Interpolates inside the landing segment: reporting the nearest vertex would
// measure this harness's own resolution (~0.15 mi) instead of the placement.
const landsAtMi = (geom, cum, frac) => {
  const want = frac * geom.mtotal;
  let i = 1;
  while (i < geom.mcum.length - 1 && geom.mcum[i] < want) i += 1;
  const span = geom.mcum[i] - geom.mcum[i - 1];
  const t = span > 0 ? (want - geom.mcum[i - 1]) / span : 0;
  return cum[i - 1] + t * (cum[i] - cum[i - 1]);
};

// ---- the corridor from the field report: I-90, Sturgis SD → Bozeman MT ----
// Latitude climbs 44.4° → 45.8° over ~430 mi, which is what pulls the two
// metrics apart. Rounded to the towns the route threads.
const I90 = densify([
  { lat: 44.4097, lng: -103.5090 }, // Sturgis
  { lat: 44.4908, lng: -103.8594 }, // Spearfish
  { lat: 44.4064, lng: -104.3758 }, // Sundance
  { lat: 44.2911, lng: -105.5022 }, // Gillette
  { lat: 44.3483, lng: -106.6989 }, // Buffalo
  { lat: 44.7972, lng: -106.9562 }, // Sheridan
  { lat: 45.3300, lng: -107.3500 }, // Lodge Grass
  { lat: 45.7300, lng: -107.6122 }, // Hardin
  { lat: 45.7833, lng: -108.5007 }, // Billings
  { lat: 45.6796, lng: -111.0448 }, // Bozeman
]);
const cum = groundCum(I90);
const total = cum[cum.length - 1];
const geom = mercatorCum(I90);

console.log(`\nI-90 corridor, ${total.toFixed(0)} mi:`);
{
  // the vertex nearest each of these positions stands in for the bike
  const bikeAt = (mi) => { let i = 1; while (cum[i] < mi) i += 1; return i; };
  let worstFixed = 0;
  let worstGround = 0;
  for (const mi of [20, 80, 150, 220, 300, 380]) {
    const i = bikeAt(mi);
    const fixed = landsAtMi(geom, cum, lineProgressAt(geom, i, 0)) - cum[i];
    const ground = landsAtMi(geom, cum, cum[i] / total) - cum[i];
    worstFixed = Math.max(worstFixed, Math.abs(fixed));
    worstGround = Math.max(worstGround, Math.abs(ground));
  }
  check('gradient split rides on the bike the whole day', worstFixed < 0.05,
    `worst ${worstFixed.toFixed(2)} mi off`);
  // the bug as reported: the split ran AHEAD of the puck and grew
  check('the ground-mile shortcut it replaced was off by miles', worstGround > 1,
    `worst ${worstGround.toFixed(2)} mi off`);
  const at80 = bikeAt(80);
  const drift = landsAtMi(geom, cum, cum[at80] / total) - cum[at80];
  check('reproduces the field report at Sheridan-minus-80 (split ~1 mi ahead)',
    drift > 0.9 && drift < 2, `${drift.toFixed(2)} mi ahead`);
}

console.log('\nmetric agrees with the map:');
{
  for (const i of [1, 500, 1200, I90.length - 2]) {
    const ours = lineProgressAt(geom, i, 0);
    const theirs = refProgress(I90, i);
    check(`vertex ${i} matches geojson-vt's own measure`, Math.abs(ours - theirs) < 1e-12,
      `${ours} vs ${theirs}`);
  }
  check('starts at 0', lineProgressAt(geom, 0, 0) === 0);
  check('ends at 1', Math.abs(lineProgressAt(geom, I90.length - 2, 1) - 1) < 1e-12);
  check('mid-segment interpolates', (() => {
    const a = lineProgressAt(geom, 500, 0);
    const b = lineProgressAt(geom, 500, 0.5);
    const c = lineProgressAt(geom, 501, 0);
    return a < b && b < c;
  })());
  check('out-of-range index reads null', lineProgressAt(geom, I90.length, 0) === null
    && lineProgressAt(geom, -1, 0) === null && lineProgressAt(undefined, 3, 0) === null);
}

console.log('\nroutes the two metrics agree on (no regression there):');
{
  // due east at one latitude — mercator scales longitude uniformly, so the
  // fractions are identical and the fix changes nothing
  const eastWest = densify([{ lat: 44.5, lng: -104.0 }, { lat: 44.5, lng: -110.0 }], 2000);
  const ewCum = groundCum(eastWest);
  const ewGeom = mercatorCum(eastWest);
  const i = Math.floor(eastWest.length / 3);
  const off = landsAtMi(ewGeom, ewCum, ewCum[i] / ewCum[ewCum.length - 1]) - ewCum[i];
  check('east–west day: ground fraction was already right', Math.abs(off) < 0.05,
    `${off.toFixed(3)} mi`);

  // a 40-mile Black Hills loop — short days never showed the bug either
  const loop = densify([
    { lat: 44.0805, lng: -103.2310 }, { lat: 43.8791, lng: -103.4591 },
    { lat: 43.8375, lng: -103.5266 }, { lat: 44.0805, lng: -103.2310 },
  ], 400);
  const lCum = groundCum(loop);
  const lGeom = mercatorCum(loop);
  const j = Math.floor(loop.length / 2);
  const lOff = landsAtMi(lGeom, lCum, lCum[j] / lCum[lCum.length - 1]) - lCum[j];
  check('short loop day: unchanged within a tenth of a mile', Math.abs(lOff) < 0.1,
    `${lOff.toFixed(3)} mi`);
  const lFixed = landsAtMi(lGeom, lCum, lineProgressAt(lGeom, j, 0)) - lCum[j];
  check('short loop day: still exact after the fix', Math.abs(lFixed) < 0.02,
    `${lFixed.toFixed(3)} mi`);
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

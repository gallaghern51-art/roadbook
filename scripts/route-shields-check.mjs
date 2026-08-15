// Highway-shield placement checks (Aug 15, 2026).
//
// Owner request: "how can we have some overlay of road signs on the map. Right
// now map covers road signs… we need some road signs on the maps on plan and
// ride to see." The engine's whole job is the word SOME — a shield on every
// maneuver is a picket fence, one per day is nothing, and what "some" means
// differs between a plan overview framing 200 miles and a nav camera framing
// a third of one.
//
// Run: node scripts/route-shields-check.mjs

import { roadShields, normalizeRoadRef, stepRoadShields } from '../src/engine/roads.js';
import { roadRuns, shieldPlacements } from '../src/engine/routeShields.js';
import { haversineMiles } from '../src/engine/tripEngine.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const keys = (list) => list.map((s) => s.key).join(',');

console.log('\nReading a road out of what the routers actually send');
{
  check('OSRM space form: "I 90"', keys(roadShields(normalizeRoadRef('I 90'))) === 'I-90');
  check('OSRM multi-ref: "US 14;US 16;US 20"',
    keys(roadShields(normalizeRoadRef('US 14;US 16;US 20'))) === 'US-14,US-16,US-20');
  check('a state route: "SD 87"', keys(roadShields(normalizeRoadRef('SD 87'))) === 'SD-87');
  check('kinds are right',
    roadShields(normalizeRoadRef('I 90'))[0].kind === 'interstate'
    && roadShields(normalizeRoadRef('US 14'))[0].kind === 'us'
    && roadShields(normalizeRoadRef('SD 87'))[0].kind === 'state');

  // The prefix list used to be the eight states the Sturgis trip crosses.
  check('a state the seed trip never enters still draws',
    keys(roadShields(normalizeRoadRef('NC 105'))) === 'NC-105');
  // The hyphen is the guard. Unhyphenated prose never matches, which is why
  // normalizeRoadRef is only ever pointed at a router's ref field or at the
  // "onto <road>" clause of an instruction — never at a free-text note.
  check('unhyphenated prose is not a route number',
    roadShields('Ride the US 1 someday').length === 0);
  check('a street name yields nothing', stepRoadShields({ road: 'Huffine Lane' }).length === 0);

  // Google carries no ref field at all — the road is prose in the instruction.
  check('Google: "Merge onto I-90 E"',
    keys(stepRoadShields({ road: null, instr: 'Merge onto I-90 E' })) === 'I-90');
  check('Google: "Continue on US-14 W toward Greybull"',
    keys(stepRoadShields({ road: null, instr: 'Continue on US-14 W toward Greybull' })) === 'US-14');
  check('the road you EXIT TOWARD is not the road you are on',
    stepRoadShields({ road: null, instr: 'Take the exit toward US-14 / Greybull' }).length === 0,
    'signing the destination would paint US-14 while still on the interstate');
  check('a real ref beats the instruction',
    keys(stepRoadShields({ road: 'I 90', instr: 'Take the exit toward US-14' })) === 'I-90');
}

console.log('\nRuns: contiguous stretches of one number');
{
  const steps = [
    { dist: 0.3, road: 'Main St' },
    { dist: 40, road: 'I 90' },
    { dist: 0.2, road: null, instr: 'Continue straight' }, // unnamed maneuver mid-interstate
    { dist: 35, road: 'I 90' },
    { dist: 0.4, road: 'I 90' },   // the off-ramp, still signed I-90
    { dist: 22, road: 'US 14' },
    { dist: 0.6, road: 'WY 32' },  // a short connector
    { dist: 18, road: 'US 14' },
  ];
  const runs = roadRuns(steps);
  check('the interstate is ONE run, not three',
    runs.filter((r) => r.key === 'I-90').length === 1,
    runs.map((r) => `${r.key}:${r.miles.toFixed(1)}`).join(' '));
  check('an unnamed maneuver extends the run rather than breaking it',
    Math.abs(runs.find((r) => r.key === 'I-90').miles - 75.6) < 0.01);
  check('the two US-14 stretches are separate runs (a real road change between)',
    runs.filter((r) => r.key === 'US-14').length === 2);
  check('run mileage is measured along the route',
    Math.abs(runs.find((r) => r.key === 'US-14').miles - 22) < 0.01);
}

// ---- a synthetic 200-mile day, straight north, vertex every 0.5 mi ----
const LAT0 = 44.0;
const LNG0 = -103.5;
const chain = [];
for (let mi = 0; mi <= 200; mi += 0.5) chain.push({ lat: LAT0 + mi / 69.17, lng: LNG0 });
const cum = [0];
for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));

const DAY = [
  { dist: 0.5, road: 'Main St' },
  { dist: 120, road: 'I 90' },
  { dist: 0.4, road: 'WY 194' },  // ramp — too short to sign
  { dist: 79.1, road: 'US 14' },
];

console.log('\nPlan overview: sparse, and every road change signed');
{
  const p = shieldPlacements(DAY, chain, { cum });
  check('something is placed', p.length > 0);
  check('both real roads are signed',
    new Set(p.map((x) => x.key)).size === 2 && p.some((x) => x.key === 'I-90') && p.some((x) => x.key === 'US-14'),
    [...new Set(p.map((x) => x.key))].join(','));
  check('the 0.4-mi ramp is NOT signed', !p.some((x) => x.key === 'WY-194'));
  check('a 120-mi interstate repeats a few times, not a few dozen',
    p.filter((x) => x.key === 'I-90').length >= 3 && p.filter((x) => x.key === 'I-90').length <= 6,
    `${p.filter((x) => x.key === 'I-90').length} shields`);
  check('placements come back in route order',
    p.every((x, i) => i === 0 || x.mi >= p[i - 1].mi));

  // A shield has to sit ON the road it names.
  const bad = p.filter((x) => {
    const onLine = chain.some((c) => haversineMiles(c, x) < 0.4);
    const inRun = x.key === 'I-90' ? x.mi > 0.5 && x.mi < 120.5 : x.mi > 120.9 && x.mi < 200;
    return !onLine || !inRun;
  });
  check('every shield sits on the line, inside the stretch it names', bad.length === 0,
    bad.map((b) => `${b.key}@${b.mi.toFixed(1)}`).join(' '));

  const usFirst = p.filter((x) => x.key === 'US-14').sort((a, b) => a.mi - b.mi)[0];
  check('the US-14 shield lands where US-14 actually starts, not 40 mi in',
    usFirst.mi < 145, `first US-14 shield at mile ${usFirst.mi.toFixed(1)}`);
}

console.log('\nRide: signed every quarter mile around the bike');
{
  const at = 60;
  const p = shieldPlacements(DAY, chain, { cum, nearMi: at });
  const near = p.filter((x) => Math.abs(x.mi - at) <= 2);
  check('the stretch around the bike is signed repeatedly', near.length >= 12,
    `${near.length} shields within 2 mi`);
  check('…every quarter mile', near.every((x, i) => i === 0 || x.mi - near[i - 1].mi <= 0.26));
  check('a nav camera showing 3/4 mi of road has one in the frame',
    p.filter((x) => x.mi > at && x.mi < at + 0.75).length >= 2,
    'sign spacing has to beat the camera, not the map scale');
  check('and the far end of the day is still sparse',
    p.filter((x) => x.mi > 150).length <= 4);

  // Marker churn: the placement ids have to hold still as the bike moves,
  // or every shield remounts (and blinks) once a second.
  const a = shieldPlacements(DAY, chain, { cum, nearMi: 60 });
  const b = shieldPlacements(DAY, chain, { cum, nearMi: 60.5 });
  const held = a.filter((x) => b.some((y) => y.id === x.id));
  check('half a mile of riding keeps most markers alive', held.length >= a.length - 3,
    `${held.length}/${a.length} ids survived`);
  check('…and moves the window along', b.some((y) => !a.some((x) => x.id === y.id)));
}

console.log('\nDegenerate input');
{
  check('no steps', shieldPlacements([], chain, { cum }).length === 0);
  check('no geometry', shieldPlacements(DAY, [], {}).length === 0);
  check('a day with no numbered roads at all',
    shieldPlacements([{ dist: 30, road: 'Beartooth Highway' }], chain, { cum }).length === 0);
  check('nothing but ramps', shieldPlacements(
    [{ dist: 0.3, road: 'I 90' }, { dist: 0.4, road: 'US 14' }], chain, { cum }
  ).length === 0);
  check('the whole-day ceiling holds', shieldPlacements(
    Array.from({ length: 400 }, (_, i) => ({ dist: 2, road: `US ${i % 90}` })), chain, { cum }
  ).length <= 40);
  check('geometry shorter than the step chain still lands on the line', (() => {
    const short = chain.slice(0, 40); // 20 mi of geometry for a 200-mi step list
    const p = shieldPlacements(DAY, short, {});
    return p.length > 0 && p.every((x) => short.some((c) => haversineMiles(c, x) < 0.4));
  })());
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

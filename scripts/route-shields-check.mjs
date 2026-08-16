// Highway-shield placement checks (Aug 15, 2026).
//
// Owner request: "how can we have some overlay of road signs on the map. Right
// now map covers road signs… we need some road signs on the maps." The
// engine's whole job is the word SOME — a shield on every maneuver is a
// picket fence and one per day is nothing.
//
// Ride Mode gets the same runs through a different door: `aheadMi` builds a
// sparse ladder of candidates on the road IN FRONT of the bike, of which the
// HUD draws exactly one ("add the signs to ride mode but I don't want it to
// be overbearing on the view"). Shields went into Ride unbounded on the first
// pass and came straight back out, so the cap is the feature.
//
// Run: node scripts/route-shields-check.mjs

import { roadShields, normalizeRoadRef, stepRoadShields } from '../src/engine/roads.js';
import { roadRuns, shieldPlacements, AHEAD_SPAN_MI } from '../src/engine/routeShields.js';
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
  check('exactly one shield per run is flagged as the road CHANGE',
    p.filter((x) => x.first).length === 2
    && p.filter((x) => x.first).every((f) => p.every((o) => o.key !== f.key || o.mi >= f.mi)),
    'the flag is what stops a long interstate eating every slot in the '
    + 'screen-space cull and leaving the next road unsigned');
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

console.log('\nRide: a sparse ladder on the road AHEAD');
{
  const at = 60;
  const p = shieldPlacements(DAY, chain, { cum, aheadMi: at });
  const base = shieldPlacements(DAY, chain, { cum });   // the same day, no bike
  const added = (mi) => shieldPlacements(DAY, chain, { cum, aheadMi: mi })
    .filter((x) => !base.some((y) => y.id === x.id)).sort((a, b) => a.mi - b.mi);

  // A sparse grid means a bike is often BETWEEN candidates — that is the point
  // now — so the guarantee is per two miles ridden, not per position.
  const window = [];
  for (let mi = 58; mi < 60; mi += 0.05) window.push(...added(mi).map((x) => x.mi));
  check('two miles of riding always brings a sign round', window.length > 0);
  check('none is signed on the ground under the puck', !p.some((x) => Math.abs(x.mi - at) < 0.15),
    'a shield at the bike sits under the marker that matters most');
  check('nothing new BEHIND the bike',
    added(at).every((x) => x.mi > at),
    'a sign behind you has been ridden past, and with one slot it would take it');
  check('nothing new beyond a nav camera\'s horizon either',
    added(at).every((x) => x.mi <= at + AHEAD_SPAN_MI + 0.01),
    'the ladder is a look-ahead, not the whole day');

  // THE frequency test. Owner, Aug 16 2026, having ridden the half-mile grid:
  // "the road signs are appearing too frequently, I want them at one third to
  // one fourth the frequency." Ride draws ONE sign, so the number a rider
  // experiences is how many distinct signs they pass in a stretch of road —
  // measured here by riding the ladder rather than by reading the constant.
  {
    const seen = new Set();
    for (let mi = 40; mi <= 60; mi += 0.05) {
      for (const x of shieldPlacements(DAY, chain, { cum, aheadMi: mi })) {
        if (x.mi > mi && x.mi <= mi + AHEAD_SPAN_MI) seen.add(x.id);
      }
    }
    check('a rider passes ~1 sign every 2 miles, not 1 every half mile',
      seen.size >= 9 && seen.size <= 12, `${seen.size} signs over 20 mi of I-90`);
  }
  // …and the clear stretches are the other half of that ask: at half-mile
  // spacing there was always something on screen, which is wallpaper.
  {
    let bare = 0;
    let total = 0;
    for (let mi = 40; mi <= 60; mi += 0.05) {
      total += 1;
      const p2 = shieldPlacements(DAY, chain, { cum, aheadMi: mi });
      if (!p2.some((x) => x.mi > mi && x.mi <= mi + 0.75)) bare += 1; // 0.75 mi ≈ what a nav camera frames
    }
    check('most of the ride has no sign on screen at all', bare / total > 0.5,
      `${Math.round((bare / total) * 100)}% of the stretch is clear`);
  }

  // Marker churn: the ids sit on a fixed grid, so riding slides the ladder
  // rather than tearing every marker down and remounting it (which re-fetches
  // the artwork and blinks the sign).
  const a = shieldPlacements(DAY, chain, { cum, aheadMi: 60 });
  const b = shieldPlacements(DAY, chain, { cum, aheadMi: 60.25 });
  check('a quarter mile of riding keeps the markers alive',
    a.filter((x) => b.some((y) => y.id === x.id)).length >= a.length - 1);

  // At a road change the old number must not be the one still standing.
  const near = shieldPlacements(DAY, chain, { cum, aheadMi: 120.3 })
    .filter((x) => x.mi > 120.3 && x.mi < 122);
  check('past the road change, every sign ahead names the NEW road',
    near.length > 0 && near.every((x) => x.key === 'US-14'),
    near.map((x) => `${x.key}@${x.mi.toFixed(2)}`).join(' '));

  // The grid got 4× sparser; the one message that must NOT wait for it is the
  // road change. It is placed off-grid, just past the change, and flagged
  // `first` so the screen-space cull seats it ahead of any repeat.
  {
    // US-14 starts at mile 120.9; the next 2-mile grid point is 122, so on the
    // grid alone the new road would go unsigned for its first mile.
    const approach = shieldPlacements(DAY, chain, { cum, aheadMi: 120.4 })
      .filter((x) => x.key === 'US-14');
    check('the road change is signed the moment it is in reach',
      approach.length > 0 && approach[0].mi < 122 && approach[0].first,
      approach.map((x) => `${x.mi.toFixed(2)}${x.first ? '*' : ''}`).join(' '));
    check('…and it sits on the NEW road, past the change', approach.every((x) => x.mi > 120.9),
      'signed one foot early it names US-14 while the bike is still on I-90');
  }
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
  ).length <= 24);
  check('geometry shorter than the step chain still lands on the line', (() => {
    const short = chain.slice(0, 40); // 20 mi of geometry for a 200-mi step list
    const p = shieldPlacements(DAY, short, {});
    return p.length > 0 && p.every((x) => short.some((c) => haversineMiles(c, x) < 0.4));
  })());
}

console.log(`\n${pass}/${pass + fail} checks passed${fail ? ' — FAILURES ABOVE' : ''}`);
process.exit(fail ? 1 : 0);

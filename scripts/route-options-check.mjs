// Route options checks (Sep 20, 2026).
//
// Owner, on the quick-ride door: "it doesn't allow user to see the different
// recommended routes per selection 'quick, touring, back roads'. so if someone
// selects 'quick' they should be able to see the available recommended options
// like google maps/apple maps does before they select."
//
// The numbers below are MEASURED, not invented — public Valhalla motorcycle
// costing, Minneapolis → Rapid City, Sep 20 2026:
//
//   use_highways 1    (quick)     primary 610.4 mi / 530.4 min
//                                 alternates 576.7/516.5, 585.6/529.2
//   use_highways 0.5  (touring)   primary 576.7 mi / 515.5 min
//                                 alternates 610.4/529.4, 585.5/528.3
//   use_highways 0.05 (backroads) primary 603.7 mi / 731.2 min
//
// Two things fall out of that and both are asserted here:
//
//   1. The chip that says QUICK was being answered with a road 33.7 miles
//      longer and 14 minutes slower than one sitting in its own alternates
//      list. A label that promises speed must be answered with the fastest
//      road of its set.
//
//   2. Quick and Touring converge on the same road. Two identical lines on a
//      map is not a choice — they merge into one option wearing both labels.
//
// Run: node scripts/route-options-check.mjs        (mocked, deterministic)
//      node scripts/route-options-check.mjs --live (also hits real Valhalla)

import { routeOptions, tripRoads, viaLabel, roadOverlap } from '../src/engine/routeOptions.js';
import { resetRouterBackoff } from '../src/engine/routing.js';

// node's own, captured before anything mocks it: `delete globalThis.fetch`
// does not "unmask" a built-in here, it removes fetch from the process.
const nodeFetch = globalThis.fetch;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- polyline6, the encoder side (routing.js only decodes) ----
function encode6(points) {
  let lat = 0; let lng = 0; let out = '';
  const chunk = (v) => {
    let n = v < 0 ? ~(v << 1) : (v << 1);
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const [x, y] of points) {
    const la = Math.round(y * 1e6); const ln = Math.round(x * 1e6);
    out += chunk(la - lat) + chunk(ln - lng);
    lat = la; lng = ln;
  }
  return out;
}

// A road between the same two endpoints, bowed by `bow` degrees of latitude so
// the cell-overlap test can tell it from its neighbours.
const A = [-93.2650, 44.9778]; // Minneapolis
const B = [-103.2310, 44.0805]; // Rapid City
function road(bow, n = 60) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    pts.push([
      A[0] + (B[0] - A[0]) * f,
      A[1] + (B[1] - A[1]) * f + Math.sin(f * Math.PI) * bow,
    ]);
  }
  return pts;
}

// Four distinct roads. Bows are ~0.3°+ apart (≈33 km) so no two share cells.
const ROADS = {
  i90: { bow: 0.00, miles: 576.7, min: 515.5, names: ['I 90', 'I 90 West'] },
  north: { bow: 0.60, miles: 610.4, min: 530.4, names: ['I 94 West', 'US 12'] },
  mid: { bow: -0.55, miles: 585.5, min: 528.3, names: ['US 14', 'US 14 West'] },
  small: { bow: 1.30, miles: 603.7, min: 731.2, names: ['MN 7', 'SD 34 West', 'CR 5'] },
};

function trip(key) {
  const r = ROADS[key];
  const shape = encode6(road(r.bow));
  return {
    summary: { length: r.miles, time: r.min * 60 },
    legs: [{
      shape,
      maneuvers: [
        { length: 2, time: 200, street_names: ['4th Avenue South'], type: 1 },
        { length: r.miles - 4, time: r.min * 60 - 400, street_names: r.names, type: 8 },
        { length: 2, time: 200, street_names: ['East Boulevard'], type: 4 },
      ],
    }],
  };
}

// What the public server actually hands back, per style.
const RESPONSES = {
  1: { trip: trip('north'), alternates: [{ trip: trip('i90') }, { trip: trip('mid') }] },
  0.5: { trip: trip('i90'), alternates: [{ trip: trip('north') }, { trip: trip('mid') }] },
  0.05: { trip: trip('small'), alternates: [{ trip: trip('i90') }] },
};

let requests = [];
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const hw = body.costing_options.motorcycle.use_highways;
  const res = RESPONSES[hw];
  if (!res) throw new Error(`no mock for use_highways ${hw}`);
  return { ok: true, status: 200, json: async () => structuredClone(res) };
};

if (process.argv.includes('--live')) await runLive();

console.log('\nroute options — the merge');
globalThis.fetch = mockFetch;
resetRouterBackoff();
requests = [];
const opts = await routeOptions({
  start: { lat: A[1], lng: A[0] },
  end: { lat: B[1], lng: B[0] },
  avoidTolls: false,
});

check('one request per style', requests.length === 3, `${requests.length}`);
check('alternates are asked for on a two-point route',
  requests.every((r) => r.alternates > 0), JSON.stringify(requests.map((r) => r.alternates)));
check('each style rides its own use_highways weight',
  new Set(requests.map((r) => r.costing_options.motorcycle.use_highways)).size === 3);

const quick = opts.find((o) => o.styles.includes('quick'));
check('Quick is answered with the FASTEST road of its set, not the primary',
  Math.round(quick.miles * 10) / 10 === 576.7,
  `got ${quick.miles.toFixed(1)} mi / ${quick.minutes.toFixed(1)} min (the primary was 610.4/530.4)`);
check('…and that is faster than the road it used to offer',
  quick.minutes < 530.4, `${quick.minutes.toFixed(1)} min`);

check('Quick and Touring converge into ONE option',
  quick.styles.includes('touring'), JSON.stringify(opts.map((o) => o.styles)));
check('…wearing both labels', quick.label === 'Quick · Touring', quick.label);

const back = opts.find((o) => o.styles.includes('backroads'));
check('Back roads stays its own option', !!back && back.miles > 600 && back.minutes > 700,
  back ? `${back.miles.toFixed(1)}/${back.minutes.toFixed(0)}` : 'missing');
check('Back roads is not also labelled Quick', !back.styles.includes('quick'));

const alts = opts.filter((o) => o.kind === 'alternate');
check('the roads no style picked are offered as alternates', alts.length === 2, `${alts.length}`);
check('alternates are labelled as such', alts.every((a) => a.label === 'Alternate'));
check('every option is a distinct road',
  opts.every((a, i) => opts.every((b, j) => i === j || roadOverlap(a.geometry, b.geometry) < 0.85)));
check('no duplicate of the back-roads primary from its own alternates list',
  opts.filter((o) => Math.abs(o.miles - 603.7) < 0.2).length === 1);

console.log('\nroute options — the facts on each row');
check('style options come before alternates',
  opts.findIndex((o) => o.kind === 'alternate') > opts.findLastIndex((o) => o.kind === 'style'));
check('the fastest option is flagged', opts.filter((o) => o.fastest).length >= 1);
check('the fastest flag lands on the quickest row',
  opts.find((o) => o.fastest).minutes === Math.min(...opts.map((o) => o.minutes)));
check('delta against the fastest is reported',
  back.deltaMinutes > 200, `${back.deltaMinutes.toFixed(0)} min`);
check('a via label names the road that carries the route',
  quick.via === 'I-90', quick.via);
check('…and the back road names its own', back.via.includes('MN-7') || back.via.includes('SD-34'), back.via);
check('a driveway that carries no distance is never the label',
  !opts.some((o) => /Avenue|Boulevard/.test(o.via)));
check('every option carries geometry to draw',
  opts.every((o) => Array.isArray(o.geometry) && o.geometry.length > 10));
check('every option carries the prefs that produced it',
  opts.every((o) => o.prefs && typeof o.prefs.style === 'string'));

console.log('\nroute options — a road that is worse at everything is not an option');
// Live MN → Rapid City offered 681.2 mi / 13.96 h and 695.8 mi / 14.20 h
// alongside a Back roads answer of 603.7 / 12.19 — about 13% longer and 15%
// slower. Those are dropped; a near-tie (585.5 / 8.80 against 576.7 / 8.59) is
// exactly what a directions screen is for, and is kept.
requests = [];
globalThis.fetch = async (url, init) => {
  const hw = JSON.parse(init.body).costing_options.motorcycle.use_highways;
  const long = { summary: { length: 695.8, time: 14.20 * 3600 }, legs: [{ shape: encode6(road(-1.6)), maneuvers: [{ length: 690, time: 50000, street_names: ['US 212'] }] }] };
  return { ok: true, status: 200, json: async () => ({ ...structuredClone(RESPONSES[hw]), alternates: [...(RESPONSES[hw].alternates ?? []), { trip: long }].map((x) => structuredClone(x)) }) };
};
const trimmed = await routeOptions({ start: { lat: A[1], lng: A[0] }, end: { lat: B[1], lng: B[0] } });
check('the road that is longer AND far slower never reaches the list',
  !trimmed.some((o) => Math.abs(o.miles - 695.8) < 1), JSON.stringify(trimmed.map((o) => o.miles.toFixed(1))));
check('the near-tie alternate survives',
  trimmed.some((o) => Math.abs(o.miles - 585.5) < 1));
check('the list stays glanceable', trimmed.length <= 4, `${trimmed.length}`);

console.log('\nroute options — group pace rides at read time');
requests = [];
const pacedOpts = await routeOptions({
  start: { lat: A[1], lng: A[0] }, end: { lat: B[1], lng: B[0] }, pace: 1.15,
});
check('pace multiplies the clock, never the miles',
  Math.abs(pacedOpts[0].minutes - opts[0].minutes * 1.15) < 0.1
  && Math.abs(pacedOpts[0].miles - opts[0].miles) < 0.01,
  `${pacedOpts[0].minutes.toFixed(1)} vs ${(opts[0].minutes * 1.15).toFixed(1)}`);

console.log('\nroute options — a day with stops in it');
// Measured twice on the public server: one break_through in the middle and
// alternates come back empty. The engine must not ask for what it cannot get,
// and must still return one option per style.
requests = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const hw = body.costing_options.motorcycle.use_highways;
  return { ok: true, status: 200, json: async () => ({ trip: RESPONSES[hw].trip }) };
};
const withStop = await routeOptions({
  start: { lat: A[1], lng: A[0] },
  stops: [{ lat: 43.5460, lng: -96.7313 }],
  end: { lat: B[1], lng: B[0] },
});
check('no alternates are requested once a stop is in the middle',
  requests.every((r) => !r.alternates), JSON.stringify(requests.map((r) => r.alternates ?? 0)));
check('the stop rides as break_through, the ends as break',
  requests[0].locations.length === 3
  && requests[0].locations[1].type === 'break_through'
  && requests[0].locations[2].type === 'break');
check('the styles are still offered', withStop.length === 3 || withStop.length === 2,
  `${withStop.length} options`);
check('…and every one is a style answer, none an alternate',
  withStop.every((o) => o.kind === 'style'));

console.log('\nroute options — only one way to go');
// Red Lodge → Cooke City: one road over the Beartooth, every style the same
// answer, zero alternates. The list must be ONE option, not an error and not
// three identical lines.
globalThis.fetch = async (url, init) => {
  requests.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ trip: trip('i90') }) };
};
const onlyOne = await routeOptions({ start: { lat: A[1], lng: A[0] }, end: { lat: B[1], lng: B[0] } });
check('three identical answers collapse to one option', onlyOne.length === 1, `${onlyOne.length}`);
check('…and it names every style that lands on it',
  onlyOne[0].styles.length === 3, JSON.stringify(onlyOne[0].styles));
check('…with a label a rider can read', onlyOne[0].label === 'Quick · Touring · Back roads', onlyOne[0].label);

console.log('\nroute options — one dead style does not kill the screen');
let n = 0;
globalThis.fetch = async (url, init) => {
  const hw = JSON.parse(init.body).costing_options.motorcycle.use_highways;
  n += 1;
  if (hw === 0.05) return { ok: false, status: 429, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => structuredClone(RESPONSES[hw]) };
};
const partial = await routeOptions({ start: { lat: A[1], lng: A[0] }, end: { lat: B[1], lng: B[0] } });
check('the styles that answered are still offered', partial.length >= 1, `${partial.length}`);
check('…and the dead one is simply absent',
  !partial.some((o) => o.styles.includes('backroads')));

console.log('\nroute options — every style down is an error, not an empty list');
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
let threw = false;
try { await routeOptions({ start: { lat: A[1], lng: A[0] }, end: { lat: B[1], lng: B[0] } }); }
catch { threw = true; }
check('a total outage throws so the caller can say so', threw);

console.log('\nroad identification');
const t = trip('i90');
check('tripRoads ranks by miles carried', tripRoads(t)[0].key === 'I-90');
check('viaLabel drops roads under the share floor', viaLabel(t, 576.7) === 'I-90');
check('roadOverlap: a road against itself is 1', roadOverlap(road(0), road(0)) === 1);
check('roadOverlap: roads 30 km apart do not match', roadOverlap(road(0), road(0.6)) < 0.85,
  roadOverlap(road(0), road(0.6)).toFixed(2));
check('roadOverlap: the same road re-sampled still matches',
  roadOverlap(road(0, 60), road(0, 140)) >= 0.85, roadOverlap(road(0, 60), road(0, 140)).toFixed(2));

// ---- live ----
// Runs FIRST when asked for: the mocked outage cases below deliberately drive
// routing.js into its 10-minute Valhalla backoff, and a live call afterwards
// would be refused by our own engine rather than by the server.
async function runLive() {
  console.log('\nLIVE — public Valhalla');
  const mocked = globalThis.fetch;
  globalThis.fetch = nodeFetch;
  resetRouterBackoff();
  try {
    const live = await routeOptions({
      start: { lat: 44.9778, lng: -93.2650 },
      end: { lat: 44.0805, lng: -103.2310 },
    });
    console.log(live.map((o) => `    ${o.label.padEnd(24)} ${o.miles.toFixed(1)} mi  ${(o.minutes / 60).toFixed(2)} h  ${o.via}`).join('\n'));
    check('live: at least two roads to choose between', live.length >= 2, `${live.length}`);
    check('live: the Quick row is the fastest row',
      live.find((o) => o.styles?.includes('quick'))?.fastest === true);

    const pass2 = await routeOptions({
      start: { lat: 45.1855, lng: -109.2468 }, // Red Lodge
      end: { lat: 45.0219, lng: -109.9310 }, // Cooke City, over the Beartooth
    });
    console.log(pass2.map((o) => `    ${o.label.padEnd(24)} ${o.miles.toFixed(1)} mi  ${(o.minutes / 60).toFixed(2)} h  ${o.via}`).join('\n'));
    check('live: one road over the pass is one option', pass2.length === 1, `${pass2.length}`);
  } catch (e) {
    check('live Valhalla reachable', false, e.message);
  }
  globalThis.fetch = mocked;
  resetRouterBackoff(); // a live failure must not refuse the mocked cases below
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

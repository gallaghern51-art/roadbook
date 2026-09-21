// Routing a day in WINDOWS: does it resume where each chunk left off, what
// happens when the day changes, and does the stitched result hold together?
//
// Owner, Sep 21 2026: "when app breaks it into chunks, does it know to
// continue where each break up left off? how does it handle changes? how does
// it look when its all pieced together?"
//
// Background: the public Valhalla caps a request at 10 locations (error 150),
// and a rally day carries 12–15 stops. `valhallaWindows` splits the day into
// windows of ≤10 that SHARE their boundary stop, each window is requested in
// order, and the legs and summary are stitched back into one trip.
//
// Three things are worth real scrutiny rather than reasoning, and each has a
// section below:
//
//  1. COVERAGE — a shared boundary means leg n→n+1 must land in exactly one
//     window. Off by one either way and the day silently loses a leg or
//     charges for one twice.
//  2. THE SEAM — the boundary stop is sent as `break` in both windows where a
//     single request would have sent `break_through`. A `break` makes a U-turn
//     legal there, so a windowed route CAN differ from an unwindowed one. The
//     live section measures by how much against a ground truth.
//  3. THE JOIN — `valhallaGeometry` welds legs with `shape.slice(1)`, assuming
//     leg n's last vertex is leg n+1's first. That holds inside one response.
//     ACROSS two responses it depends on Valhalla snapping the boundary stop
//     identically both times, which is not guaranteed.
//
// Run: node scripts/route-windows-check.mjs        (pure + mocked)
//      node scripts/route-windows-check.mjs --live (also the ground truth)

if (typeof globalThis.localStorage === 'undefined') {
  const mem = new Map();
  globalThis.localStorage = {
    get length() { return mem.size; },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

const nodeFetch = globalThis.fetch;
const { valhallaWindows, VALHALLA_MAX_LOCATIONS, valhallaRoute, routeDay, resetRouterBackoff, clearRouteCaches } = await import('../src/engine/routing.js');
const { legKey } = await import('../src/engine/tripEngine.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---- polyline6 ----
const enc6 = (pts) => {
  let out = ''; let plat = 0; let plng = 0;
  const chunk = (v0) => { let s = ''; let v = v0 < 0 ? ~(v0 << 1) : (v0 << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6); const b = Math.round(lng * 1e6); out += chunk(a - plat) + chunk(b - plng); plat = a; plng = b; }
  return out;
};
function dec6(str) {
  const out = []; let lat = 0; let lng = 0; let i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0; let result = 0; let byte;
      do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

// A synthetic day: N stops marching east, 0.1° apart. `seed` shifts the whole
// day to fresh coordinates — routeDay caches by COORDINATE, and
// clearRouteCaches() only empties localStorage, not the module's in-memory
// copy, so two sections routing the same points would silently replay the
// first one's answer instead of calling the mock.
const dayOf = (n, seed = 0) => Array.from({ length: n }, (_, i) => ({
  id: `w${seed}_${i}`, name: `Stop ${i}`, lat: 44 + seed + i * 0.01, lng: -104 - i * 0.1,
}));
const locsOf = (wps) => [
  { lon: wps[0].lng, lat: wps[0].lat, type: 'break' },
  ...wps.slice(1).map((w, i, arr) => ({ lon: w.lng, lat: w.lat, type: i === arr.length - 1 ? 'break' : 'break_through' })),
];

// ═══ 1. COVERAGE ═══
console.log('\nthe day is cut into windows that share a stop');
for (const [n, max] of [[15, 10], [11, 10], [10, 10], [2, 10], [19, 10], [20, 10], [100, 10], [7, 4]]) {
  const locs = locsOf(dayOf(n));
  const wins = valhallaWindows(locs, max);
  const label = `${n} stops, cap ${max}`;
  const sizesOk = wins.every((w) => w.length <= max && w.length >= 2);
  const legs = wins.reduce((s, w) => s + w.length - 1, 0);
  // every original leg, exactly once
  const seen = new Map();
  for (const w of wins) {
    for (let i = 0; i < w.length - 1; i++) {
      const k = `${w[i].lon},${w[i].lat}->${w[i + 1].lon},${w[i + 1].lat}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  const everyLegOnce = Array.from({ length: n - 1 }, (_, i) => `${locs[i].lon},${locs[i].lat}->${locs[i + 1].lon},${locs[i + 1].lat}`)
    .every((k) => seen.get(k) === 1);
  const noExtras = seen.size === n - 1;
  const shared = wins.every((w, i) => i === 0 || (w[0].lon === wins[i - 1].at(-1).lon && w[0].lat === wins[i - 1].at(-1).lat));
  // A window covers max-1 legs, and there are n-1 legs to cover, so this is
  // the fewest windows the cap allows. Splitting a day costs a round trip to a
  // community server and puts a `break` where a `break_through` would be, so
  // the right number of chunks is always the smallest number that fits.
  const fewest = Math.ceil((n - 1) / (max - 1));
  check(`${label}: ${wins.length} window(s), every one within the cap`, sizesOk, JSON.stringify(wins.map((w) => w.length)));
  check(`${label}: legs add up to ${n - 1}`, legs === n - 1, `${legs}`);
  check(`${label}: each leg is routed exactly once — none lost, none charged twice`, everyLegOnce && noExtras);
  check(`${label}: each window PICKS UP at the stop the last one ended on`, shared);
  check(`${label}: ${wins.length} window(s) is the FEWEST the cap allows — never split more than it must`,
    wins.length === fewest, `${wins.length} vs ${fewest}`);
  if (n <= max) {
    check(`${label}: under the cap it is not split at all, and not even rewritten`,
      wins.length === 1 && wins[0] === locs, wins[0] === locs ? 'one window' : 'the day was copied');
  }
}

console.log('\nwhat the router is told at a seam');
{
  const locs = locsOf(dayOf(15));
  const wins = valhallaWindows(locs, 10);
  check('a window opens and closes on a true break — a U-turn there is legal, which is what a stop is',
    wins.every((w) => w[0].type === 'break' && w.at(-1).type === 'break'));
  check('everything inside a window still rides through without a U-turn',
    wins.every((w) => w.slice(1, -1).every((l) => l.type === 'break_through')));
  check('the original day is untouched — windowing copies, never mutates',
    locs[9].type === 'break_through', locs[9].type);
  check('a day inside the cap is handed back whole, same array',
    valhallaWindows(locs.slice(0, 8), 10).length === 1);
  check('the cap matches what the public server enforces', VALHALLA_MAX_LOCATIONS === 10);
}

// ═══ 2. STITCH ═══
// A faithful mock: each window answers with legs whose shapes join end-to-end,
// and whose last vertex is exactly the next window's first.
const requests = [];
// 20 vertices per leg, so the normal step between vertices is small enough
// that a boundary disagreement shows up as an anomaly rather than hiding in
// the sampling
const SHAPE_PTS = 20;
const leg = (a, b, miles, mins) => ({
  shape: enc6(Array.from({ length: SHAPE_PTS + 1 }, (_, k) => {
    const f = k / SHAPE_PTS;
    return [a.lon + (b.lon - a.lon) * f, a.lat + (b.lat - a.lat) * f];
  })),
  summary: { length: miles, time: mins * 60 },
  maneuvers: [
    { type: 1, instruction: 'Ride.', street_names: ['US 14'], length: miles, time: mins * 60, begin_shape_index: 0 },
    { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: SHAPE_PTS },
  ],
});
const mockValhalla = ({ drift = 0 } = {}) => async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const L = body.locations;
  const legs = [];
  for (let i = 0; i < L.length - 1; i++) {
    // `drift` moves the window's FIRST vertex off the shared stop, the way a
    // second request snapping the boundary a few metres differently would
    const a = i === 0 && requests.length > 1 ? { ...L[i], lon: L[i].lon + drift } : L[i];
    legs.push(leg(a, L[i + 1], 10, 12));
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ trip: { legs, summary: { length: 10 * legs.length, time: 12 * 60 * legs.length, has_toll: false }, status: 0, units: 'miles' } }),
  };
};

console.log('\npieced back together');
globalThis.fetch = mockValhalla();
resetRouterBackoff();
requests.length = 0;
{
  const wps = dayOf(15);
  const trip = await valhallaRoute(wps[0], wps.slice(1), { style: 'touring', avoidTolls: false });
  check('two requests for a 15-stop day', requests.length === 2, `${requests.length}`);
  check('…each inside the cap', requests.every((r) => r.locations.length <= 10), JSON.stringify(requests.map((r) => r.locations.length)));
  check('…and they go out IN ORDER, never racing',
    requests[0].locations[0].lon === -104 && requests[1].locations[0].lon === -104 - 0.9);
  check('the stitched day has one leg per gap between stops', trip.legs.length === 14, `${trip.legs.length}`);
  check('the seam does not duplicate a leg', new Set(trip.legs.map((l) => l.shape)).size === trip.legs.length);
  check('miles are the sum of the windows', Math.round(trip.summary.length) === 140, `${trip.summary.length}`);
  check('so are minutes', Math.round(trip.summary.time / 60) === 168, `${trip.summary.time / 60}`);
}

console.log('\nthe drawn line, across the join');
{
  // valhallaGeometry is not exported; routeDay is the door that uses it
  clearRouteCaches(); resetRouterBackoff(); requests.length = 0;
  globalThis.fetch = mockValhalla();
  const wps = dayOf(15);
  const res = await routeDay({ id: 'd1', waypoints: wps }, { style: 'touring', avoidTolls: false });
  const g = res.geometry;
  check('the day draws as ONE line', Array.isArray(g) && g.length > 10, `${g?.length} vertices`);
  // a weld that dropped a vertex too many leaves a gap; one too few leaves a repeat
  let repeats = 0; let maxJump = 0;
  for (let i = 1; i < g.length; i++) {
    const dx = Math.abs(g[i][0] - g[i - 1][0]); const dy = Math.abs(g[i][1] - g[i - 1][1]);
    if (dx === 0 && dy === 0) repeats += 1;
    maxJump = Math.max(maxJump, Math.hypot(dx, dy));
  }
  check('no vertex is repeated where two legs meet', repeats === 0, `${repeats} repeats`);
  const stepList = [];
  for (let i = 1; i < g.length; i++) stepList.push(Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]));
  const med = [...stepList].sort((a, b) => a - b)[Math.floor(stepList.length / 2)];
  check('no gap opens at the seam — the biggest step is a normal one',
    maxJump <= med * 1.5 + 1e-9, `worst ${maxJump.toFixed(5)}° vs normal ${med.toFixed(5)}°`);
  check('every leg is keyed to its own pair of stops', Object.keys(res.legs).length === 14, `${Object.keys(res.legs).length}`);
  check('every leg is keyed to the RIGHT pair, the seam included',
    wps.slice(0, -1).every((w, i) => Number.isFinite(res.legs[legKey(w, wps[i + 1])]?.miles)),
    Object.keys(res.legs).length ? `first key ${Object.keys(res.legs)[0]}` : 'none');
  check('…including the leg that spans the seam itself',
    Number.isFinite(res.legs[legKey(wps[9], wps[10])]?.miles));
}

console.log('\nwhen the two halves disagree about the boundary');
{
  // The risk worth measuring: two separate requests may snap the shared stop
  // a few metres apart, and the weld cannot invent the missing piece. What it
  // CAN do is drop the next leg's first vertex (`shape.slice(1)`), which turns
  // out to absorb a small disagreement into the normal vertex spacing rather
  // than leaving a tear. Both ends of that are measured here.
  const seamStats = async (drift, seed) => {
    clearRouteCaches(); resetRouterBackoff(); requests.length = 0;
    globalThis.fetch = mockValhalla({ drift });
    const wps = dayOf(15, seed);
    const res = await routeDay({ id: `dd${seed}`, waypoints: wps }, { style: 'touring', avoidTolls: false });
    const g = res.geometry;
    const steps = [];
    for (let i = 1; i < g.length; i++) steps.push(Math.hypot(g[i][0] - g[i - 1][0], g[i][1] - g[i - 1][1]));
    const sorted = [...steps].sort((a, b) => a - b);
    const m = (d) => d * 111_320 * Math.cos(45 * Math.PI / 180);
    return {
      windows: requests.length,
      normal: m(sorted[Math.floor(sorted.length / 2)]),
      worst: m(sorted.at(-1)),
      vertices: g.length,
    };
  };

  const small = await seamStats(0.002, 1); // ~160 m
  console.log(`     160 m disagreement → normal step ${small.normal.toFixed(0)} m, worst ${small.worst.toFixed(0)} m, ${small.windows} windows`);
  check('the day really was routed in two windows (so the disagreement was in play)',
    small.windows === 2, `${small.windows}`);
  check('a boundary disagreement the size of a road snap leaves NO visible step',
    small.worst <= small.normal * 1.1, `worst ${small.worst.toFixed(0)} m vs normal ${small.normal.toFixed(0)} m`);
  check('…because the weld drops the next leg\'s first vertex, absorbing it into the normal spacing',
    small.worst < 500);

  const big = await seamStats(0.05, 4); // ~4 km — far past anything a snap would do
  console.log(`     4 km disagreement   → normal step ${big.normal.toFixed(0)} m, worst ${big.worst.toFixed(0)} m`);
  check('a disagreement big enough to matter DOES show, rather than being hidden',
    big.worst > big.normal * 1.5, `worst ${big.worst.toFixed(0)} m vs normal ${big.normal.toFixed(0)} m`);
  check('and even then the line stays continuous — one long step, not a break',
    big.vertices > 10 && Number.isFinite(big.worst));
}

// ═══ 3. CHANGES ═══
console.log('\nwhen the day changes');
{
  clearRouteCaches(); resetRouterBackoff();
  globalThis.fetch = mockValhalla();
  const prefs = { style: 'touring', avoidTolls: false };
  const wps = dayOf(15, 2);

  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps }, prefs);
  const first = requests.length;
  await routeDay({ id: 'd3', waypoints: wps }, prefs);
  check('routing the same day again costs nothing', requests.length === first, `${requests.length - first} extra`);

  requests.length = 0;
  const moved = wps.map((w, i) => (i === 7 ? { ...w, lat: w.lat + 0.05 } : w));
  await routeDay({ id: 'd3', waypoints: moved }, prefs);
  check('moving ONE stop re-routes the day', requests.length > 0, `${requests.length} requests`);
  check('…and it is still cut into windows', requests.length === 2, `${requests.length}`);

  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps.slice(0, 9) }, prefs);
  check('a day that drops back under the cap goes out as ONE request',
    requests.length === 1, `${requests.length}`);

  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps.slice(0, 11) }, prefs);
  check('adding the stop that crosses the cap splits it again',
    requests.length === 2, `${requests.length}`);

  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps }, { style: 'backroads', avoidTolls: false });
  check('asking for a different road character re-routes rather than reusing the old line',
    requests.length === 2 && requests.every((r) => r.costing_options.motorcycle.use_highways === 0.05),
    `${requests.length} requests`);

  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps.map((w) => ({ ...w, id: `${w.id}-renamed`, name: 'New name' })) }, prefs);
  check('renaming a stop does NOT re-route — the road did not move',
    requests.length === 0, `${requests.length} requests`);

  // Settings offers "clear route caches". Emptying only localStorage left the
  // module answering from its in-memory copy until the next reload, so the
  // button appeared to do nothing — caught here because two sections that
  // cleared between them were served the first one's answer.
  await routeDay({ id: 'd3', waypoints: wps }, prefs);
  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps }, prefs);
  check('…and the cached day is still cached', requests.length === 0, `${requests.length}`);
  clearRouteCaches();
  requests.length = 0;
  await routeDay({ id: 'd3', waypoints: wps }, prefs);
  check('clearing the route caches really clears them — the day is routed again',
    requests.length === 2, `${requests.length} requests`);
}

console.log('\nwhen a window fails');
{
  clearRouteCaches(); resetRouterBackoff();
  let n = 0;
  globalThis.fetch = async (url, init) => {
    n += 1;
    if (n === 2) return { ok: false, status: 429, json: async () => ({}) };
    return (await mockValhalla()(url, init));
  };
  requests.length = 0;
  const wps = dayOf(15, 3);
  const res = await routeDay({ id: 'd4', waypoints: wps }, { style: 'touring', avoidTolls: false });
  check('a day whose second window is refused does not silently draw half a route',
    res.source === 'osrm' || Object.keys(res.legs ?? {}).length !== 9,
    `source=${res.source}, ${Object.keys(res.legs ?? {}).length} legs`);
}

// ═══ 4. LIVE GROUND TRUTH ═══
if (process.argv.includes('--live')) {
  console.log('\nLIVE — the same road, routed whole and routed in windows');
  globalThis.fetch = nodeFetch;
  resetRouterBackoff(); clearRouteCaches();
  // seven real stops along US-14/16 through the Bighorns: inside the cap, so
  // the whole route is a ground truth the windowed one can be judged against
  const stops = [
    { lat: 44.2969, lng: -105.5050, name: 'Gillette' },
    { lat: 44.3683, lng: -106.6989, name: 'Buffalo' },
    { lat: 44.4419, lng: -107.0731, name: 'Powder River Pass' },
    { lat: 44.5150, lng: -107.3120, name: 'Ten Sleep Canyon' },
    { lat: 44.0344, lng: -107.4498, name: 'Ten Sleep' },
    { lat: 44.0169, lng: -107.9560, name: 'Worland' },
    { lat: 44.5269, lng: -108.0740, name: 'Greybull' },
  ];
  const post = async (locations) => {
    const res = await nodeFetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations,
        costing: 'motorcycle',
        costing_options: { motorcycle: { use_highways: 0.5, use_tolls: 0.5, use_trails: 0 } },
        directions_options: { units: 'miles' },
      }),
    });
    if (!res.ok) throw new Error(`valhalla ${res.status}`);
    return (await res.json()).trip;
  };
  const weld = (trip) => {
    const g = [];
    for (const l of trip.legs) { const s = dec6(l.shape ?? ''); g.push(...(g.length ? s.slice(1) : s)); }
    return g;
  };
  try {
    const locs = locsOf(stops);
    const whole = await post(locs);
    const wholeG = weld(whole);
    console.log(`     whole  : ${whole.summary.length.toFixed(1)} mi · ${(whole.summary.time / 60).toFixed(0)} min · ${whole.legs.length} legs`);

    const wins = valhallaWindows(locs, 4); // force two windows over the same stops
    const trips = [];
    for (const w of wins) { trips.push(await post(w)); await new Promise((r) => setTimeout(r, 400)); }
    const stitched = {
      legs: trips.flatMap((t) => t.legs),
      summary: {
        length: trips.reduce((s, t) => s + t.summary.length, 0),
        time: trips.reduce((s, t) => s + t.summary.time, 0),
      },
    };
    const stitchedG = weld(stitched);
    console.log(`     windows: ${stitched.summary.length.toFixed(1)} mi · ${(stitched.summary.time / 60).toFixed(0)} min · ${stitched.legs.length} legs (${wins.map((w) => w.length).join('+')})`);

    check('live: the windowed day has the same number of legs as the whole one',
      stitched.legs.length === whole.legs.length, `${stitched.legs.length} vs ${whole.legs.length}`);
    const dMiles = stitched.summary.length - whole.summary.length;
    const dMin = (stitched.summary.time - whole.summary.time) / 60;
    console.log(`     seam cost: ${dMiles >= 0 ? '+' : ''}${dMiles.toFixed(2)} mi · ${dMin >= 0 ? '+' : ''}${dMin.toFixed(1)} min`);
    check('live: cutting the day into windows does not change the road it rides',
      Math.abs(dMiles) < 1.0, `${dMiles.toFixed(2)} mi difference`);
    check('live: nor the time it takes', Math.abs(dMin) < 3, `${dMin.toFixed(1)} min`);

    // the join, on real geometry
    let maxJump = 0;
    for (let i = 1; i < stitchedG.length; i++) {
      maxJump = Math.max(maxJump, Math.hypot(stitchedG[i][0] - stitchedG[i - 1][0], stitchedG[i][1] - stitchedG[i - 1][1]));
    }
    let wholeMax = 0;
    for (let i = 1; i < wholeG.length; i++) {
      wholeMax = Math.max(wholeMax, Math.hypot(wholeG[i][0] - wholeG[i - 1][0], wholeG[i][1] - wholeG[i - 1][1]));
    }
    const m = (d) => d * 111_320 * Math.cos(44.3 * Math.PI / 180);
    console.log(`     biggest step between vertices: whole ${m(wholeMax).toFixed(0)} m · windowed ${m(maxJump).toFixed(0)} m`);
    check('live: the welded line is as continuous as the unwelded one',
      m(maxJump) <= Math.max(m(wholeMax) * 1.5, m(wholeMax) + 50),
      `${m(maxJump).toFixed(0)} m vs ${m(wholeMax).toFixed(0)} m`);
  } catch (e) {
    check('live Valhalla reachable', false, e.message);
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

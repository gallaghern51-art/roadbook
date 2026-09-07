// Valhalla verification: the FOSSGIS endpoint is mocked with a spec-shaped
// response (polyline6 shapes, per-leg summaries, maneuver enums). Planning
// must use it directly; nav and live reroutes must use it before Google.
// Neither path may fall through to another routing engine.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const REVIEW = (n) => new URL(`../../.impeccable/review/${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

// polyline6 encoder (lat-first, 1e6 precision — the Valhalla shape format)
const enc6 = (pts) => {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => {
    let s = '';
    v = v < 0 ? ~(v << 1) : (v << 1);
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of pts) {
    const ilat = Math.round(lat * 1e6), ilng = Math.round(lng * 1e6);
    out += enc(ilat - plat) + enc(ilng - plng);
    plat = ilat; plng = ilng;
  }
  return out;
};

let valhallaCalls = 0, valhallaCosting = null, valhallaLocationTypes = [], valhallaOptions = [];
let googleRouteCalls = 0, osrmPlanningCalls = 0, osrmStepsCalls = 0;
let delayRouteChoices = false;

function buildValhalla(reqBody) {
  valhallaCalls++;
  valhallaCosting = reqBody.costing;
  valhallaLocationTypes.push(reqBody.locations.map((l) => l.type));
  valhallaOptions.push(reqBody.costing_options?.motorcycle ?? null);
  const locs = reqBody.locations.map((l) => [l.lon, l.lat]);
  const highwayBias = reqBody.costing_options?.motorcycle?.use_highways ?? 0.5;
  const bend = highwayBias <= 0.05 ? 0.018 : highwayBias >= 0.95 ? -0.01 : 0;
  const legs = [];
  let totalMi = 0, totalSec = 0;
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i], b = locs[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length, ny = dx / length;
    const offset = (point) => [point[0] + nx * bend, point[1] + ny * bend];
    const pts = [a, offset(lerp(a, b, 0.4)), offset(lerp(a, b, 0.7)), b];
    const mi = pts.slice(1).reduce((sum, point, index) => sum + hav(pts[index], point), 0);
    const sec = (mi / 50) * 3600;
    totalMi += mi; totalSec += sec;
    legs.push({
      shape: enc6(pts),
      summary: { length: mi, time: sec },
      maneuvers: [
        { type: i === 0 ? 1 : 8, instruction: 'Ride north on Spur Road.', street_names: ['Spur Road'], length: mi * 0.6, time: sec * 0.6, begin_shape_index: 0 },
        { type: 15, instruction: 'Turn left onto Granite Pass Road.', street_names: ['Granite Pass Road'], length: mi * 0.4, time: sec * 0.4, begin_shape_index: 2 },
        { type: 4, instruction: 'You have arrived at your destination.', length: 0, time: 0, begin_shape_index: 3 },
      ],
    });
  }
  return { trip: { legs, summary: { length: totalMi, time: totalSec }, status: 0, units: 'miles' } };
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('/.netlify/functions/google-route')) {
    googleRouteCalls++;
    return r.continue();
  }
  if (u.includes('localhost:5199')) return r.continue();
  if (u.includes('valhalla1.openstreetmap.de/route')) {
    const body = r.request().postDataJSON();
    if (delayRouteChoices) {
      const useHighways = body.costing_options?.motorcycle?.use_highways;
      const delay = useHighways === 1 ? 700 : useHighways === 0.05 ? 450 : 180;
      return new Promise((resolve) => setTimeout(resolve, delay))
        .then(() => r.fulfill({ json: buildValhalla(body) }).catch(() => {}));
    }
    return r.fulfill({ json: buildValhalla(body) });
  }
  if (u.includes('router.project-osrm.org')) {
    // attachRoadDetail legitimately asks OSRM for lane data (annotations=false);
    // only a ROUTING fallback (annotations=distance,duration) would mean the
    // Valhalla tier was skipped.
    if (u.includes('steps=true') && u.includes('annotations=distance')) osrmStepsCalls++;
    if (u.includes('steps=false') && u.includes('annotations=distance,duration')) osrmPlanningCalls++;
    // OSRM is still served so either fallback produces a debuggable failure.
    const m = /driving\/([^?]+)\?/.exec(u);
    const coords = m[1].split(';').map((p) => p.split(',').map(Number));
    const geometry = [];
    const legs = coords.slice(1).map((b, i) => {
      const a = coords[i];
      const pts = [a]; for (let k = 1; k <= 8; k++) pts.push(lerp(a, b, k / 9)); pts.push(b);
      geometry.push(...(i ? pts.slice(1) : pts));
      return { distance: hav(a, b) * 1609.34, duration: 1800, annotation: { distance: [hav(a, b) * 1609.34], duration: [1800] } };
    });
    return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs, geometry: { coordinates: geometry } }], waypoints: coords.map((c) => ({ distance: 8, location: c })) } });
  }
  return r.abort();
});
await page.addInitScript(() => {
  const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: (cb) => { if (window.__lastFix) cb(window.__lastFix); } };
  Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  window.__feed = (lat, lng, heading, mps) => {
    window.__lastFix = { coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() };
    window.__geoCb?.(window.__lastFix);
  };
});
await page.goto('http://localhost:5199/');
const guestEntry = page.locator('.land-skip');
if (await guestEntry.isVisible().catch(() => false)) await guestEntry.click();
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(600);
await page.evaluate(() => {
  const mk = (id, name, lat, lng) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '' });
  const dayBase = {
    miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [],
    gates: [{ waypointId: 'va', by: '10:00 AM', label: 'Timed canyon entry' }],
    meals: [{ meal: 'lunch', name: 'Rider’s Table', where: 'Granite', note: 'Flexible lunch pick' }],
    photos: [], modules: [], ops: [], lodging: { status: 'booked', name: 'End Lodge', where: 'Granite', note: 'Confirmed' },
  };
  window.__dispatch({
    type: 'create_trip',
    name: 'VALHALLA TEST',
    trip: {
      meta: { title: 'VALHALLA TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
      days: [{ ...dayBase, id: 'v1', dow: 'Wed', date: '2026-08-12', title: 'Valhalla day', phase: 'rally', waypoints: [mk('vs', 'Basecamp', 44.0, -108.0), mk('va', 'Granite Diner', 44.06, -107.95), mk('vb', 'End Lodge', 44.10, -107.88)] }],
      reserveNow: [{ id: 'reservation-test', name: 'Canyon entry permit', done: true }],
    },
  });
});
await page.waitForTimeout(1200);

const planningValhallaCalls = valhallaCalls;
check(planningValhallaCalls >= 1 && valhallaCosting === 'motorcycle',
  `planning fetched from Valhalla with motorcycle costing (${planningValhallaCalls} call(s))`);
check(valhallaLocationTypes.some((types) => types.length >= 3
  && types.slice(1, -1).every((type) => type === 'break_through')
  && types.at(-1) === 'break'),
`planning preserves legs without permitting intermediate U-turns`);
check(osrmPlanningCalls === 0, `OSRM planning fallback never engaged (${osrmPlanningCalls})`);

// The overview control is an op-backed trip preference, not ornamental UI.
// Its selection must invalidate planning and change Valhalla's request body.
if (await page.locator('.main').getAttribute('data-panel') === 'closed') {
  await page.locator('.modebar button', { hasText: 'Plan' }).evaluate((el) => el.click());
  await page.waitForFunction(() => document.querySelector('.main')?.dataset.panel === 'open');
}
await page.locator('.side-inner').evaluate((el) => {
  const pref = el.querySelector('.route-pref');
  el.scrollTop = Math.max(0, (pref?.offsetTop ?? 0) - 20);
});
const routeBox = await page.locator('.route-style-grid').boundingBox();
check(Boolean(routeBox && routeBox.x >= 0 && routeBox.x + routeBox.width <= 375 && routeBox.y >= 0 && routeBox.y < 750),
  'route character is reachable inside the open phone panel');
check(await page.locator('.route-engine', { hasText: /Valhalla motorcycle/i }).isVisible(),
  'Trip settings names the motorcycle routing engine');
check(await page.locator('.route-style-grid [role="radio"][aria-checked="true"]', { hasText: 'Touring' }).isVisible(),
  'legacy trips open on the neutral Touring route character');

// A route character is now a protected replan. The click computes a draft,
// leaves the stored/shared choice alone, and only commits after the rider sees
// the route and stop impact.
delayRouteChoices = true;
const quick = page.locator('.route-style-grid [role="radio"]', { hasText: 'Quick' });
await quick.click();
await page.waitForSelector('.route-preview-loading');
check(await page.locator('.route-style-grid [role="radio"][aria-checked="true"]', { hasText: 'Touring' }).isVisible(),
  'previewing a character does not mutate the active trip');
await page.waitForSelector('.route-preview-metrics', { timeout: 10000 });
check(await page.locator('.route-preview-sheet', { hasText: /Touring.*Quick/s }).isVisible(),
  'route comparison names the current and proposed characters');
check(await page.locator('.route-preview-sheet', { hasText: 'Keep every stop' }).isVisible(),
  'route comparison makes stop preservation an explicit decision');
check(await page.locator('.map-legend .preview-key').isVisible(),
  'proposed Valhalla geometry is identified on the map');
const previewPaint = await page.evaluate(() => ({
  color: window.__map?.getPaintProperty('route-preview-v1-line', 'line-color'),
  opacity: window.__map?.getPaintProperty('route-preview-v1-line', 'line-opacity'),
  glow: window.__map?.getPaintProperty('route-preview-v1-glow', 'line-opacity'),
}));
check(previewPaint.color === '#3ee3d8' && previewPaint.opacity > 0 && previewPaint.glow > 0,
  'proposed geometry is visibly painted as the turquoise comparison line');
check(await page.locator('.route-preview-close').evaluate((button) => document.activeElement === button),
  'route comparison takes keyboard focus on entry');
await page.locator('.route-preview-actions .btn', { hasText: 'Cancel' }).click();
check(await quick.getAttribute('aria-checked') === 'false', 'cancel leaves Quick unapplied');
delayRouteChoices = false;

const backRoads = page.locator('.route-style-grid [role="radio"]', { hasText: 'Back roads' });
await backRoads.click();
await page.waitForSelector('.route-preview-metrics', { timeout: 10000 });
await page.screenshot({ path: SHOT('valhalla-route-character-preview'), fullPage: true });
await page.screenshot({ path: REVIEW('mobile'), fullPage: true });
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await page.waitForTimeout(200);
await page.screenshot({ path: REVIEW('mobile-light'), fullPage: true });
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.locator('.route-preview-actions .btn', { hasText: 'Keep every stop' }).click();
await page.waitForFunction(() => document.querySelector('.route-style-grid [aria-checked="true"]')?.textContent?.includes('Back roads'));

const beforePreference = valhallaCalls;
const preferenceRequest = page.waitForRequest((req) => {
  if (!req.url().includes('valhalla1.openstreetmap.de/route')) return false;
  try {
    const options = req.postDataJSON()?.costing_options?.motorcycle;
    return options?.use_highways === 0.05 && options?.use_tolls === 0;
  } catch { return false; }
});
await page.locator('.route-tolls input').click();
await preferenceRequest;
await page.waitForSelector('.route-preview-metrics', { timeout: 10000 });
await page.locator('.route-preview-actions .btn', { hasText: 'Keep every stop' }).click();
await page.waitForTimeout(800);
const chosen = valhallaOptions.at(-1);
check(valhallaCalls > beforePreference && chosen?.use_highways === 0.05 && chosen?.use_tolls === 0 && chosen?.use_trails === 0,
  `UI reroutes with back-road, no-toll motorcycle costing (${JSON.stringify(chosen)})`);
const storedPrefs = await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1') || 'null');
  return lib?.trips?.find((x) => x.id === lib.activeId)?.trip?.meta?.routePrefs;
});
check(storedPrefs?.style === 'backroads' && storedPrefs?.avoidTolls === true,
  'route character persists on the trip through set_meta');
await page.screenshot({ path: SHOT('valhalla-route-character'), fullPage: true });
const phoneFit = await page.locator('.route-pref').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
check(phoneFit, 'route control fits the phone panel without horizontal clipping');
await page.setViewportSize({ width: 1366, height: 900 });
await page.waitForTimeout(400);
const desktopFit = await page.locator('.route-pref').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
check(desktopFit, 'route control fits the desktop panel without horizontal clipping');
await page.screenshot({ path: SHOT('valhalla-route-character-desktop') });
await page.locator('.route-style-grid [role="radio"]', { hasText: 'Touring' }).click();
await page.waitForSelector('.route-preview-metrics', { timeout: 10000 });
// The sheet and map overlay commit in the same React render; give MapLibre one
// paint frame before capturing the dark comparison artifact.
await page.waitForTimeout(250);
await page.screenshot({ path: REVIEW('desktop') });
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await page.waitForTimeout(250);
await page.screenshot({ path: SHOT('valhalla-route-character-desktop-light') });
await page.screenshot({ path: REVIEW('desktop-light') });
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await page.locator('.route-preview-actions .btn', { hasText: 'Cancel' }).click();
await page.setViewportSize({ width: 375, height: 750 });
await page.waitForTimeout(400);

await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForTimeout(1200);
check(valhallaCalls > planningValhallaCalls,
  `nav steps fetched through Valhalla (${planningValhallaCalls}→${valhallaCalls} calls)`);
const navOptions = valhallaOptions.at(-1);
check(navOptions?.use_highways === 0.05 && navOptions?.use_tolls === 0,
  'Ride Mode inherits the trip route character');
check(osrmStepsCalls === 0, `OSRM routing fallback never engaged (${osrmStepsCalls})`);

// ride a little so the turn card renders Valhalla's instruction text
const navStart = [-108.0, 44.0], navStop = [-107.95, 44.06];
const navDx = navStop[0] - navStart[0], navDy = navStop[1] - navStart[1];
const navLen = Math.hypot(navDx, navDy);
const navBend = lerp(navStart, navStop, 0.4);
navBend[0] += (-navDy / navLen) * 0.018;
navBend[1] += (navDx / navLen) * 0.018;
for (const t of [0.05, 0.12, 0.2]) {
  const [lng, lat] = lerp(navStart, navBend, t / 0.4);
  await page.evaluate(([feedLat, feedLng]) => window.__feed(feedLat, feedLng, 30, 15), [lat, lng]);
  await page.waitForTimeout(350);
}
const card = await page.locator('.turn-card').textContent().catch(() => '');
check(/Spur Road|Granite Pass Road|Arrive/.test(card), `turn card speaks Valhalla maneuvers ("${card.trim().slice(0, 60)}…")`);
const nn = await page.locator('.rb-next').textContent().catch(() => '');
check(nn.includes('Granite Diner'), `next stop reads off the machine ("${nn.trim()}")`);

// deliberate retarget exercises routeFrom through the same tier
await page.locator('.ride-bar').click();
await page.waitForSelector('.stop-card', { timeout: 5000 });
const before = valhallaCalls;
await page.locator('.stop-card', { hasText: 'End Lodge' }).locator('.sc-actions button', { hasText: 'Go next' }).click();
await page.waitForTimeout(800);
check(valhallaCalls > before, `Go next rerouted through Valhalla (${before}→${valhallaCalls})`);
check(googleRouteCalls === 0, `Google never replaced the Valhalla plan (${googleRouteCalls} routing calls)`);
const nn2 = await page.locator('.rb-next').textContent().catch(() => '');
check(nn2.includes('End Lodge'), `retarget landed ("${nn2.trim()}")`);
await page.screenshot({ path: SHOT('valhalla-nav') });

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

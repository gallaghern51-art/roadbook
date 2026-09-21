// A proposal becomes a trip at once — and then it can be edited (Sep 20 2026).
//
// Owner: "roadbook spits out a recommended plan and then user should be able
// to edit that and then move things around, or save for later" — and, asked
// which way to build it, "i want whats best for user".
//
// Every tool that sentence names already exists in the trip editor: reorder,
// move a stop between days, add, remove, undo, saved Plans, and a library that
// backs up to the account. What stood between a chosen proposal and those tools
// was "Create this trip" running a SECOND full planner generation. This proves
// the new door: the proposal (with a stop the rider replaced by hand) becomes a
// real trip with no model call, and that trip is a normal, fully editable one.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/concept-instant-create-check.mjs

import { chromium } from '../../node_modules/playwright-core/index.mjs';
// Answers Mapbox's style, tiles AND telemetry. Aborting telemetry instead races
// mapbox-gl's own teardown: a map removed before its map-load event fails calls
// `this.errorCb`, which remove() already nulled — a library error, not ours.
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://127.0.0.1:${PORT}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
let pass = 0; let fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (ok) pass++; else fail++; };

const option = {
  id: 'mountain-1', title: 'Passes + hot springs', summary: 'Best blend of roads and recovery',
  routeDescription: 'US-550 over the San Juan passes, then a verified hot-springs stay that sets up the next morning.',
  why: 'The signature road, lunch and overnight form one coherent day.',
  groupFit: 'Fuel is inside the comfort range.',
  tradeoff: 'Adds mountain weather exposure.',
  searchPolyline: 'siobFrimqSkd_@cgN_db@_aM_od@kxKo`Vja@_cQvG',
  metrics: { depart: '06:45', miles: 238, rideMinutes: 326, dwellMinutes: 95, totalMinutes: 421, dayCount: 2, longestDayMinutes: 260, longestFuelGap: 112, ascentFeet: 8100, deltaMiles: 0, deltaMinutes: 0 },
  locations: [
    { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
    { name: 'Million Dollar Highway', lat: 37.9, lng: -107.67, kind: 'road', detail: 'US-550' },
    { name: 'Conoco, Ouray', lat: 38.02, lng: -107.67, kind: 'fuel', placeId: 'fuel-1', verified: 'google' },
    { name: 'Brickhouse 737', lat: 38.021, lng: -107.671, kind: 'food', placeId: 'food-1', verified: 'google', detail: '737 Main St, Ouray', dwell: 60 },
    { name: 'Ouray Hot Springs', lat: 38.03, lng: -107.67, kind: 'lodging', placeId: 'stay-1', detail: 'Recovery-night anchor' },
    { name: 'Red Mountain Pass', lat: 37.9, lng: -107.71, kind: 'road' },
    { name: 'Silverton Diner', lat: 37.81, lng: -107.66, kind: 'food', placeId: 'food-2', verified: 'google', detail: 'Verified breakfast stop' },
    { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'end' },
  ],
};
const FOOD_ROWS = [
  { id: 'g-maggies', source: 'google', name: "Maggie's Kitchen", detail: '520 Main St, Ouray, CO', lat: 38.022, lng: -107.672, rating: 4.6, userRatingCount: 330, priceLevel: 'PRICE_LEVEL_INEXPENSIVE', primaryType: 'hamburger_restaurant', types: ['restaurant'], openNow: true, status: 'OPERATIONAL' },
];

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const enc6 = (pts) => {
  let out = ''; let plat = 0; let plng = 0;
  const enc = (v0) => { let s = ''; let v = v0 < 0 ? ~(v0 << 1) : (v0 << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6); const b = Math.round(lng * 1e6); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
};
const valhalla = (body) => {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    legs.push({ shape: enc6([locs[i], lerp(locs[i], locs[i + 1], 0.5), locs[i + 1]]), summary: { length: 20, time: 1800 }, maneuvers: [{ type: 1, instruction: 'Ride.', length: 20, time: 1800, begin_shape_index: 0 }, { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2 }] });
  }
  return { trip: { legs, summary: { length: 20 * legs.length, time: 1800 * legs.length }, status: 0, units: 'miles' } };
};

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
const errors = [];
let exploreCalls = 0; let generateCalls = 0;
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/*', async (route) => {
  const url = route.request().url();
  if (routeMapbox(route)) return undefined;
  if (isMockTile(url)) return route.fulfill({ status: 204 });
  if (url.includes('/.netlify/functions/planner-background')) return route.fulfill({ status: 404, body: 'not available' });
  if (url.includes('/.netlify/functions/nearby-places')) return route.fulfill({ json: FOOD_ROWS });
  if (url.includes('/.netlify/functions/evaluate-route')) {
    const c = route.request().postDataJSON().concepts[0];
    return route.fulfill({ json: { options: [{ id: c.id, title: c.title, locations: c.locations, searchPolyline: option.searchPolyline, metrics: { ...option.metrics, miles: 241 } }], baselineId: c.id } });
  }
  if (url.includes('/.netlify/functions/chat')) {
    const body = route.request().postDataJSON();
    let done;
    if (body.mode === 'explore') {
      exploreCalls++;
      done = { type: 'done', text: 'Here is the strongest option.', concepts: [option], recommendedId: option.id, ms: 900 };
    } else {
      generateCalls++;
      done = { type: 'done', trip: { meta: { title: 'X' }, days: [] }, ms: 900 };
    }
    return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${JSON.stringify({ type: 'start', ms: 0 })}\n${JSON.stringify(done)}\n` });
  }
  if (url.includes('valhalla1.openstreetmap.de/route')) return route.fulfill({ json: valhalla(route.request().postDataJSON()) });
  if (url.includes('router.project-osrm.org')) return route.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
  if (url.startsWith(BASE)) return route.continue();
  return route.abort();
});

await page.goto(`${BASE}/`);
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.hm-pill', { timeout: 15000 });
const libBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1') ?? '{"trips":[]}').trips.length);
await page.locator('.hm-pill').click();
await page.fill('.hm-input', 'Four riders, two days in the San Juans, a hot springs night and great food.');
await page.waitForSelector('.hm-ai.lead', { timeout: 5000 });
await page.locator('.hm-ai').click();
await page.waitForSelector('.trip-builder');
await page.locator('.construction-composer .btn', { hasText: 'Explore the trip' }).click();
await page.waitForSelector('.concept-stops li');

// the rider replaces one dinner by hand first
await page.locator('.concept-stops li', { hasText: 'Brickhouse 737' }).getByRole('button', { name: 'Replace' }).click();
await page.waitForSelector('.concept-replace .nb-list .nb-item', { timeout: 8000 });
await page.locator('.concept-replace .nb-main', { hasText: "Maggie's Kitchen" }).click();
await page.locator('.concept-replace .nb-actions .btn', { hasText: 'Use this instead' }).click();
await page.waitForFunction(() => /241/.test(document.querySelector('.concept-facts')?.innerText ?? ''), null, { timeout: 8000 });

// ── Create, now ──
const t0 = Date.now();
await page.locator('.construction-confirm .btn', { hasText: 'Create this trip' }).click();
await page.waitForSelector('.modebar', { timeout: 10000 });
const took = Date.now() - t0;
check(generateCalls === 0, `Create this trip builds it with NO planner generation (${generateCalls} generate calls)`);
check(exploreCalls === 1, 'the only planner turn was the one that proposed the options');
check(took < 3000, `and it is in the editor in ${took} ms — not the 20–60 s a second generation took`);

const trip = await page.evaluate(() => {
  const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
  return { count: l.trips.length, active: l.trips.find((r) => r.id === l.activeId)?.trip };
});
check(trip.count === libBefore + 1, 'it is saved to the library straight away — "save for later" is simply the trip');
const days = trip.active?.days ?? [];
check(days.length === 2, `the overnight splits it into two days (${days.length})`);
const names = days.flatMap((d, i) => (i === 0 ? d.waypoints : d.waypoints.slice(1))).map((w) => w.name);
check(names.includes("Maggie's Kitchen") && !names.includes('Brickhouse 737'), `the dinner the rider picked is the one in the trip (${names.join(' → ')})`);
check(days[0].waypoints.at(-1).name === 'Ouray Hot Springs' && days[1].waypoints[0].name === 'Ouray Hot Springs', 'the hot springs ends day one and starts day two');
check(days[0].lodging?.name === 'Ouray Hot Springs', 'and is day one\'s lodging');
const fuel = days[0].waypoints.find((w) => w.name === 'Conoco, Ouray');
check(fuel?.fuel === true && fuel?.placeId === 'fuel-1' && fuel?.verified === 'google', 'the fuel stop is a verified fuel stop');
check(days[0].meals?.some((m) => m.name === "Maggie's Kitchen"), 'the replaced dinner is also the day\'s meal');
check(days[1].meals?.[0]?.meal === 'breakfast', 'the breakfast the planner called a breakfast stays a breakfast');
check(/San Juan passes/.test(trip.active?.meta?.summary ?? ''), 'the planner\'s own route description is the trip summary');
check(days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? '')), 'the days are dated — it went through the same date cascade as any trip');
check(days.every((d) => d.id && d.waypoints.every((w) => w.id)), 'every day and stop has an id — it is a normal, editable trip');

// ── then move things around, in the real editor ──
// reorder: the same op the drag handle sends
const d1 = days[0];
const reversedMiddle = [d1.waypoints[0], ...d1.waypoints.slice(1, -1).reverse(), d1.waypoints.at(-1)].map((w) => w.id);
await page.evaluate(({ dayId, ids }) => window.__dispatch({ type: 'apply_ops', ops: [{ op: 'reorder_waypoints', dayId, waypointIds: ids }] }), { dayId: d1.id, ids: reversedMiddle });
await page.waitForTimeout(300);
const afterReorder = await page.evaluate((dayId) => {
  const l = JSON.parse(localStorage.getItem('moto.trips.v1'));
  return l.trips.find((r) => r.id === l.activeId).trip.days.find((d) => d.id === dayId).waypoints.map((w) => w.name);
}, d1.id);
check(afterReorder[1] === d1.waypoints.at(-2).name, `stops can be reordered (${afterReorder.join(' → ')})`);

// remove, through the stop row's own ✕
await page.locator('.rchip').nth(1).click();
await page.waitForTimeout(400);
if (!(await page.locator('.wp-row').first().isVisible().catch(() => false))) {
  const tab = page.locator('.panel-tab');
  if (await tab.isVisible().catch(() => false)) await tab.click();
}
await page.waitForSelector('.wp-row', { timeout: 8000 });
const rowsBefore = await page.locator('.wp-row').count();
await page.locator('.wp-row', { hasText: 'Million Dollar Highway' }).locator('button.rm[title="Remove stop"]').click();
await page.waitForTimeout(300);
const rowsAfter = await page.locator('.wp-row').count();
check(rowsAfter === rowsBefore - 1, `a stop can be removed from its row (${rowsBefore} → ${rowsAfter})`);

// and the whole thing is undoable
await page.locator('button', { hasText: 'Undo' }).first().click();
await page.waitForTimeout(300);
check(await page.locator('.wp-row').count() === rowsBefore, 'and undo puts it back — a safety net the builder never had');

check(errors.length === 0, `no page errors (${errors.join('; ') || 'none'})`);
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

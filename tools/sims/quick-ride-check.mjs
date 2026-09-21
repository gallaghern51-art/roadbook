// Quick Ride: one destination from where you are, straight into Ride Mode,
// as a real one-day trip — then it shows on Home as a quick ride that can be
// ridden again or promoted to a trip.
//
//   npm run dev    # :5199
//   node tools/sims/quick-ride-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const enc6 = (pts) => {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => { let s = ''; v = v < 0 ? ~(v << 1) : (v << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
};
const HERE = { lat: 44.0805, lng: -103.2310 }; // Rapid City
const DEST = { lat: 43.8791, lng: -103.4591 }; // Mount Rushmore
// Each character gets its OWN road, the way a real corridor answers: US-16
// direct, and the Iron Mountain Road the long way round. A fixture that hands
// back one road for all three collapses them into a single merged option —
// correct behaviour, but then there is no character left to choose and
// nothing to assert about the choice.
const ROADS = {
  1: { bow: 0, miles: 24, mins: 40, road: 'US-16' },
  0.5: { bow: 0, miles: 24, mins: 40, road: 'US-16' },
  0.05: { bow: 0.12, miles: 31, mins: 62, road: 'US-16A' },
};
function valhalla(body) {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const spec = ROADS[body.costing_options?.motorcycle?.use_highways] ?? ROADS[0.5];
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i], b = locs[i + 1];
    const mid = lerp(a, b, 0.5);
    legs.push({ shape: enc6([a, [mid[0], mid[1] + spec.bow], b]), summary: { length: spec.miles, time: spec.mins * 60 }, maneuvers: [
      { type: 1, instruction: 'Ride.', street_names: [spec.road], length: spec.miles, time: spec.mins * 60, begin_shape_index: 0 },
      { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2 },
    ] });
  }
  return { trip: { legs, summary: { length: spec.miles * legs.length, time: spec.mins * 60 * legs.length }, status: 0, units: 'miles' } };
}
let lastValhalla = null;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, geolocation: { latitude: HERE.lat, longitude: HERE.lng }, permissions: ['geolocation'] });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('/.netlify/functions/nearby-places')) {
    return r.fulfill({ json: [{ id: 'rush', name: 'Mount Rushmore National Memorial', detail: 'Keystone, SD', lat: DEST.lat, lng: DEST.lng, rating: 4.8, userRatingCount: 40000, primaryType: 'tourist_attraction', types: ['tourist_attraction'], status: 'OPERATIONAL', periods: [{ open: { day: 0, hour: 0, minute: 0 } }], openNow: true }] });
  }
  if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
  if (u.includes('localhost:5199')) return r.continue();
  if (u.includes('valhalla1.openstreetmap.de/route')) { lastValhalla = r.request().postDataJSON(); return r.fulfill({ json: valhalla(lastValhalla) }); }
  if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
  return r.abort();
});
await seedRideAck(page); // Ride Mode's safety gate is answered once per device
await page.goto('http://localhost:5199/');
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.home', { timeout: 15000 });
const lib = () => page.evaluate(() => JSON.parse(localStorage.getItem('moto.trips.v1')));
const before = (await lib()).trips.length;

// 1. the pill is the one door: a place → its card → Ride here → the ROUTE
// SHEET (Sep 20, 2026 — the Roads radio became the roads themselves: every
// character measured, drawn on the map and labelled before Go) → Go
await page.locator('.hm-pill').click();
await page.fill('.hm-input', 'Rushmore');
await page.waitForSelector('.hm-results button', { timeout: 8000 });
await page.locator('.hm-results button').first().click();
await page.waitForSelector('.hm-place', { timeout: 8000 });
await page.locator('.hm-place-actions .btn', { hasText: 'Ride here' }).click();
await page.waitForSelector('.route-sheet', { timeout: 10000 });
check(await page.locator('.route-sheet').count() === 1, 'Ride here opens the route sheet');
await page.waitForFunction(() => document.querySelectorAll('.rs-opt').length > 0, null, { timeout: 30000 });
const roads = await page.locator('.rs-opt .rs-opt-head b').allTextContents();
check(roads.some((r) => /Back roads/.test(r)), `every road character is offered, measured (${roads.join(' · ')})`);
await page.locator('.rs-tolls input').check();
await page.waitForFunction(() => document.querySelectorAll('.rs-opt').length > 0, null, { timeout: 30000 });
await page.locator('.rs-opt', { hasText: 'Back roads' }).first().click();
await page.waitForTimeout(400);
await page.screenshot({ path: SHOT('quick-ride-pick') });
await page.locator('.rs-actions .btn', { hasText: 'Go' }).click();

// 2. straight into Ride Mode on a real one-day trip
await page.waitForSelector('.ride-bar', { timeout: 15000 });
check(true, 'lands directly in Ride Mode');
await page.waitForTimeout(1200);
const l = await lib();
const rec = l.trips.find((r) => r.id === l.activeId);
check(l.trips.length === before + 1 && rec.trip.meta.quick === true, 'a quick ride is a real trip record flagged meta.quick');
check(rec.trip.days.length === 1 && rec.trip.days[0].waypoints.length === 2, 'one day, start → destination');
check(rec.trip.days[0].waypoints[0].name === 'Current location' && Math.abs(rec.trip.days[0].waypoints[0].lat - HERE.lat) < 1e-6, 'start is the GPS fix');
check(rec.trip.days[0].waypoints[1].placeId === 'rush' && rec.trip.days[0].waypoints[1].verified === 'google', 'destination carries place identity');
check(rec.trip.meta.routePrefs.style === 'backroads' && rec.trip.meta.routePrefs.avoidTolls === true, 'the chosen road character rode onto the trip');
check(lastValhalla?.costing_options?.motorcycle?.use_highways === 0.05 && lastValhalla?.costing_options?.motorcycle?.use_tolls === 0, 'and Valhalla was asked for back roads, no tolls');
check(rec.trip.days[0].date === new Date().toISOString().slice(0, 10), 'dated today');
await page.screenshot({ path: SHOT('quick-ride-riding') });

// 3. back on Home it is a quick ride, not a trip — and can become one
await page.locator('.ride-x, .ride-fab[aria-label="Close"], button[aria-label="End ride"], .ride-overlay-top button', { hasText: /✕|End/ }).first().click().catch(() => {});
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /^✕$/.test(x.textContent.trim())); b?.click(); });
await page.waitForTimeout(400);
await page.waitForSelector('.home', { timeout: 10000 });
// the ride sheet is still up with the ride on it — close it to see the library
await page.locator('.rs-head .mini-edit').click().catch(() => {});
await page.waitForTimeout(400);
await page.locator('.hm-handle').click().catch(() => {});
await page.waitForTimeout(400);
check(await page.locator('.quick-row').count() === 1, 'Home lists it under Quick rides');
const tripNames = await page.locator('.trip-grid:not(.start-grid) .trip-card:not(.tpl-card) .tc-name').allTextContents();
check(!tripNames.some((n) => /Ride to/.test(n)), 'and NOT under Your trips');
await page.locator('.quick-row .btn', { hasText: 'Make it a trip' }).click();
await page.waitForSelector('.modebar', { timeout: 10000 });
await page.waitForTimeout(600);
const l2 = await lib();
const promoted = l2.trips.find((r) => r.id === l2.activeId);
check(!promoted.trip.meta.quick && promoted.trip.days.length === 1, 'Make it a trip drops the flag and keeps the day');

console.log(`\n${pass}/${pass + fail} passed`);
await browser.close();
process.exit(fail ? 1 : 0);

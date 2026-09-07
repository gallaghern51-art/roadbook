// Field bug (Aug 11): leaving a stop by the road you arrived on rewinds the
// geometric projection, which resurrected the stop as the nav target — even
// after "Go next" on a later stop. Verifies: (1) parking on a non-target stop
// latches it, (2) Go next survives a projection rewind, (3) masthead back
// button + contrasted actions.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
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

function buildOsrm(url) {
  const m = /driving\/([^?]+)\?/.exec(url);
  const coords = m[1].split(';').map((p) => p.split(',').map(Number));
  const withSteps = url.includes('steps=true');
  const legs = [];
  const geometry = [coords[0]];
  let totalM = 0, totalS = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const pts = [a];
    for (let k = 1; k <= 8; k++) pts.push(lerp(a, b, k / 9));
    pts.push(b);
    geometry.push(...pts.slice(1));
    const meters = hav(a, b) * 1609.34;
    const dur = meters / 25;
    totalM += meters; totalS += dur;
    const segd = [], segt = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const md = hav(pts[k], pts[k + 1]) * 1609.34;
      segd.push(md); segt.push(md / 25);
    }
    const leg = { distance: meters, duration: dur, annotation: { distance: segd, duration: segt } };
    if (withSteps) {
      leg.steps = [
        { distance: meters, duration: dur, name: 'Spur Road', maneuver: { type: i === 0 ? 'depart' : 'continue', modifier: 'straight', location: a }, intersections: [] },
        { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: b }, intersections: [] },
      ];
    }
    legs.push(leg);
  }
  return {
    code: 'Ok',
    routes: [{ distance: totalM, duration: totalS, legs, geometry: { coordinates: geometry } }],
    waypoints: coords.map((c) => ({ distance: 8, location: c })),
  };
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.includes('localhost:5199')) return route.continue();
  if (u.includes('router.project-osrm.org')) return route.fulfill({ json: buildOsrm(u) });
  if (u.includes('overpass-api.de')) return route.fulfill({ json: { elements: [] } });
  return route.abort();
});
await page.addInitScript(() => {
  const stub = {
    watchPosition: (cb) => { window.__geoCb = cb; return 1; },
    clearWatch: () => {},
    getCurrentPosition: (cb) => { if (window.__lastFix) cb(window.__lastFix); },
  };
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

// The spur trip: S at the bottom, Cozy Cabin up a dead-end spur due north,
// Hill City Diner off to the east, lodge beyond. Leaving the cabin means
// riding back DOWN the same line — the projection-rewind geometry.
await page.evaluate(() => {
  const day = {
    id: 'sd1', dow: 'Tue', date: '2026-08-11', title: 'Spur day', phase: 'rally',
    miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false,
    summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
    lodging: { status: 'none', name: '', where: '', note: '' },
    waypoints: [
      { id: 'ws', kind: 'start', name: 'Basecamp', lat: 44.0, lng: -108.0, mile: null, note: '' },
      { id: 'wa', kind: 'via', name: 'Cozy Cabin', lat: 44.10, lng: -108.0, mile: null, note: '' },
      { id: 'wb', kind: 'via', name: 'Hill City Diner', lat: 44.05, lng: -107.85, mile: null, note: '' },
      { id: 'wc', kind: 'end', name: 'End Lodge', lat: 44.05, lng: -107.70, mile: null, note: '' },
    ],
  };
  window.__dispatch({
    type: 'create_trip',
    name: 'SPUR TEST',
    trip: { meta: { title: 'SPUR TEST', subtitle: '', summary: '', riders: 2, startDate: '2026-08-11', fuelRule: '', range: 200, roster: [] }, days: [day], reserveNow: [] },
  });
});
await page.waitForTimeout(800);

const nextName = async () => {
  const el = page.locator('.rb-next');
  return (await el.count()) ? el.textContent() : '';
};

// ---- Scenario 1: parked ON the cabin (not the target) latches it ----
await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForTimeout(800);
for (const lat of [44.10, 44.10, 44.10]) {
  await page.evaluate((l) => window.__feed(l, -108.0, 0, 0), lat);
  await page.waitForTimeout(300);
}
for (const lat of [44.094, 44.088, 44.082, 44.076, 44.068, 44.06]) {
  await page.evaluate((l) => window.__feed(l, -108.0, 180, 15), lat);
  await page.waitForTimeout(300);
}
let nn = await nextName();
check(nn.includes('Hill City Diner') && !nn.includes('Cozy Cabin'),
  `parked-at-stop latch: leaving the cabin aims at the diner ("${nn.trim()}")`);
await page.screenshot({ path: SHOT('spur-leave') });
await page.locator('.ride-x').click();
await page.waitForTimeout(600);

// ---- Scenario 2: Go next survives the projection rewind ----
await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForTimeout(800);
// past the cabin, projection on the A->B leg, never inside the 0.25-mi latch ring
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.__feed(44.098, -107.99, 120, 12));
  await page.waitForTimeout(300);
}
await page.locator('.ride-bar').click();
await page.waitForSelector('.stop-card', { timeout: 5000 });
await page.locator('.stop-card', { hasText: 'Hill City Diner' }).locator('.sc-actions button', { hasText: 'Go next' }).click();
await page.waitForTimeout(500);
// now REWIND: back onto the spur line, where the projection drops to leg 0
for (const lat of [44.09, 44.085, 44.079, 44.072, 44.065]) {
  await page.evaluate((l) => window.__feed(l, -108.0, 180, 15), lat);
  await page.waitForTimeout(300);
}
nn = await nextName();
check(nn.includes('Hill City Diner') && !nn.includes('Cozy Cabin'),
  `Go next survives projection rewind ("${nn.trim()}")`);
await page.screenshot({ path: SHOT('spur-gonext') });
await page.locator('.ride-x').click();
await page.waitForTimeout(600);

// ---- Scenario 2.5: Go next while standing AT the stop (Rushmore loop) ----
await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForTimeout(800);
// parked ~0.28 mi from the diner (outside the 0.25 latch ring, inside the
// 0.3 at-stop intercept), stationary
for (let i = 0; i < 3; i++) {
  await page.evaluate(() => window.__feed(44.054, -107.85, 0, 0));
  await page.waitForTimeout(300);
}
await page.locator('.ride-bar').click();
await page.waitForSelector('.stop-card', { timeout: 5000 });
await page.locator('.stop-card', { hasText: 'Hill City Diner' }).locator('.sc-actions button', { hasText: 'Go next' }).click();
await page.waitForTimeout(600);
nn = await nextName();
check(nn.includes('End Lodge') && !nn.includes('Hill City'),
  `at-stop Go next aims onward, no route-to-here loop ("${nn.trim()}")`);
await page.locator('.ride-x').click();
await page.waitForTimeout(600);

// ---- Scenario 3: masthead back button + contrasted actions ----
check(await page.locator('.mast-back').count() === 1, 'masthead wears a visible back button');
const gearBg = await page.locator('.masthead .actions .btn').last().evaluate((el) => getComputedStyle(el).backgroundColor);
check(gearBg !== 'rgba(0, 0, 0, 0)' && gearBg !== 'transparent', `settings button is filled, not ghost (${gearBg})`);
await page.screenshot({ path: SHOT('masthead-dark') });
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.waitForTimeout(300);
const gearBgLight = await page.locator('.masthead .actions .btn').last().evaluate((el) => getComputedStyle(el).backgroundColor);
check(gearBgLight !== gearBg && gearBgLight !== 'rgba(0, 0, 0, 0)', `light theme re-tokens the fill (${gearBgLight})`);
await page.screenshot({ path: SHOT('masthead-light') });
await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
await page.locator('.mast-back').click();
await page.waitForTimeout(600);
check(await page.locator('.trip-card').count() >= 1, 'back button lands on the trip library');

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

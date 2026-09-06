// Masthead stays ONE row at 375px (incl. map-full), ride bar wears the bigger
// type without wrapping taller.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('localhost:5199')) return r.continue();
  if (u.includes('router.project-osrm.org')) {
    const m = /driving\/([^?]+)\?/.exec(u);
    const coords = m[1].split(';').map((p) => p.split(',').map(Number));
    const withSteps = u.includes('steps=true');
    const geometry = [];
    const legs = coords.slice(1).map((b, i) => {
      const a = coords[i];
      const pts = [a]; for (let k = 1; k <= 8; k++) pts.push(lerp(a, b, k / 9)); pts.push(b);
      geometry.push(...(i ? pts.slice(1) : pts));
      const leg = { distance: 40000, duration: 1800, annotation: { distance: [40000], duration: [1800] } };
      if (withSteps) leg.steps = [
        { distance: 24000, duration: 1000, name: 'Interstate 90', ref: 'I 90', maneuver: { type: i === 0 ? 'depart' : 'continue', modifier: 'straight', location: a }, intersections: [] },
        { distance: 16000, duration: 800, name: 'Main Street', maneuver: { type: 'turn', modifier: 'right', location: pts[6] }, intersections: [] },
        { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: b }, intersections: [] },
      ];
      return leg;
    });
    return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 40000 * legs.length, duration: 1800 * legs.length, legs, geometry: { coordinates: geometry } }], waypoints: coords.map((c) => ({ distance: 8, location: c })) } });
  }
  if (u.includes('overpass-api.de')) return r.fulfill({ json: { elements: [] } });
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
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(800);

// masthead single row: back button, brand, and gear share a horizontal band
const rowY = async () => {
  const back = await page.locator('.mast-back').boundingBox();
  const gear = await page.locator('.masthead .actions .btn').last().boundingBox();
  const brand = await page.locator('.masthead h1').boundingBox();
  return { back, gear, brand };
};
let { back, gear, brand } = await rowY();
const overlaps = (a, b) => a && b && a.y < b.y + b.height && b.y < a.y + a.height;
check(overlaps(back, gear) && overlaps(brand, gear), `panel view: back/brand/gear share one row (y ${back?.y}/${brand?.y}/${gear?.y})`);

// map-full (tap PLAN again to drop to bare map — the screenshot's state)
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
({ back, gear, brand } = await rowY());
check(overlaps(back, gear) && overlaps(brand, gear), `map view: one row still (y ${back?.y}/${brand?.y}/${gear?.y})`);
await page.screenshot({ path: SHOT('masthead-onerow') });

// ride bar: bigger type, still a two-row bar that doesn't overflow its box
await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForTimeout(800);
for (let i = 0; i < 4; i++) {
  await page.evaluate((k) => {
    const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
    const rec = lib.trips.find((r) => r.id === lib.activeId);
    const w = rec.trip.days[0].waypoints[0];
    window.__feed(w.lat + 0.001 * k, w.lng + 0.001 * k, 90, 15);
  }, i);
  await page.waitForTimeout(300);
}
const big = await page.locator('.rb-big').evaluate((el) => getComputedStyle(el).fontSize);
const mid = await page.locator('.rb-mid').evaluate((el) => getComputedStyle(el).fontSize);
check(big === '38px' && mid === '18.5px', `ride bar type bumped (${big}/${mid})`);
// the turn card only exists once nav steps have resolved — wait for it
await page.waitForSelector('.t-dist', { timeout: 15000 }).catch(() => {});
const dist = await page.locator('.t-dist').first().evaluate((el) => getComputedStyle(el).fontSize).catch(() => 'n/a');
check(dist === '36px', `turn card distance bumped (${dist})`);
const bar = await page.locator('.ride-bar').boundingBox();
check(bar && bar.height < 132, `bar stays compact (${Math.round(bar?.height)}px tall)`);
const main = await page.locator('.rb-main').boundingBox();
const chip = await page.locator('.rb-chip').boundingBox().catch(() => null);
check(!chip || overlaps(main, chip), 'delta chip rides the main row, no wrap');
await page.screenshot({ path: SHOT('ride-bigtype') });

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);

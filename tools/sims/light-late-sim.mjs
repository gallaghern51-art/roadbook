// Light-theme contrast sweep + late-start latch check.
import { chromium } from '../../node_modules/playwright-core/index.mjs';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180, dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
let firstSteps = null;
function buildOsrm(url) {
  const m = /driving\/([^?]+)\?/.exec(url);
  const coords = m[1].split(';').map((p) => p.split(',').map(Number));
  const withSteps = url.includes('steps=true');
  const record = withSteps && !firstSteps;
  const legs = []; const geometry = [coords[0]];
  let totalM = 0, totalS = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const pts = [a]; for (let k = 1; k <= 8; k++) pts.push(lerp(a, b, k / 9)); pts.push(b);
    geometry.push(...pts.slice(1));
    const meters = hav(a, b) * 1609.34, dur = meters / 25;
    totalM += meters; totalS += dur;
    const segd = [], segt = [];
    for (let k = 0; k < pts.length - 1; k++) { const md = hav(pts[k], pts[k + 1]) * 1609.34; segd.push(md); segt.push(md / 25); }
    const leg = { distance: meters, duration: dur, annotation: { distance: segd, duration: segt } };
    if (withSteps) leg.steps = [
      { distance: meters, duration: dur, name: 'US 16', ref: 'US 16', maneuver: { type: i === 0 ? 'depart' : 'continue', modifier: 'straight', location: a }, intersections: [] },
      { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: b }, intersections: [] },
    ];
    legs.push(leg);
  }
  if (record) firstSteps = coords;
  return { code: 'Ok', routes: [{ distance: totalM, duration: totalS, legs, geometry: { coordinates: geometry } }], waypoints: coords.map((c) => ({ distance: 10, location: c })) };
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
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
  localStorage.setItem('moto.settings.v1', JSON.stringify({ theme: 'light' }));
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, 'speechSynthesis', { value: { speak: () => {}, cancel: () => {}, resume: () => {}, speaking: false, pending: false }, configurable: true });
  const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: () => {} };
  Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  window.__feed = (lat, lng, heading, mps) => { window.__geoCb?.({ coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() }); };
});
await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.screenshot({ path: SHOT('light-home') });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForFunction(() => {
  try { return Object.keys(JSON.parse(localStorage.getItem('sturgis.routeCache.v3') || '{}')).length >= 3; } catch { return false; }
}, { timeout: 30000 });
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
await page.locator('.rchip').nth(1).click();
await page.waitForSelector('.wp-row', { timeout: 8000 });
await page.screenshot({ path: SHOT('light-day') });
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
// ride, LATE START: first fix lands 30% into leg 3 (past two intermediate stops)
await page.click('.ride-seat');
await page.waitForSelector('.ride-mode', { timeout: 8000 });
await page.waitForFunction(() => !!window.__geoCb, { timeout: 8000 });
for (let i = 0; i < 30 && !firstSteps; i++) await page.waitForTimeout(300);
const wps = firstSteps;
const names = await page.evaluate(() => {
  const lib = JSON.parse(localStorage.getItem('moto.trips.v1'));
  const rec = lib.trips.find((r) => r.id === lib.activeId);
  const today = new Date().toLocaleDateString('sv-SE');
  const day = rec.trip.days.find((d) => d.date === today) ?? rec.trip.days[0];
  return day.waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng)).map((w) => w.name);
});
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) % 360;
{
  const p = lerp(wps[2], wps[3], 0.3);
  for (let k = 0; k < 3; k++) {
    await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 29), { lat: p[1], lng: p[0], hdg: bearing(wps[2], wps[3]) });
    await page.waitForTimeout(500);
  }
}
await page.waitForTimeout(800);
const nextTxt = await page.locator('.rb-next .mq-seg').first().textContent();
const expect = names[3] ?? '';
console.log(`${nextTxt?.includes(expect.slice(0, 8)) ? 'PASS' : 'FAIL'} late start targets the stop AHEAD — next="${nextTxt}" expected~"${expect}"`);
// light-theme ride sheet
await page.click('.ride-bar');
await page.waitForSelector('.ride-sheet', { timeout: 5000 });
await page.screenshot({ path: SHOT('light-ride-sheet') });
await browser.close();
console.log('sweep done');

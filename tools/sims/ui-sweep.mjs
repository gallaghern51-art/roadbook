// Mobile balance sweep at 375px: Home, Plan, Prep, Trip settings, Ride states.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const SHOT = (n) => new URL(`./shots/ui-${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
let firstSteps = null, firstGeom = null;

function buildOsrm(url) {
  const m = /driving\/([^?]+)\?/.exec(url);
  const coords = m[1].split(';').map((p) => p.split(',').map(Number));
  const withSteps = url.includes('steps=true');
  const record = withSteps && !firstSteps;
  const legs = []; const geometry = [coords[0]];
  let totalM = 0, totalS = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const pts = [a];
    for (let k = 1; k <= 8; k++) pts.push(lerp(a, b, k / 9));
    pts.push(b);
    geometry.push(...pts.slice(1));
    const meters = hav(a, b) * 1609.34; const dur = meters / 25;
    totalM += meters; totalS += dur;
    const segd = [], segt = [];
    for (let k = 0; k < pts.length - 1; k++) { const md = hav(pts[k], pts[k + 1]) * 1609.34; segd.push(md); segt.push(md / 25); }
    const leg = { distance: meters, duration: dur, annotation: { distance: segd, duration: segt } };
    if (withSteps) {
      leg.steps = [
        { distance: meters * 0.6, duration: dur * 0.6, name: 'Interstate 90', ref: 'I 90',
          maneuver: { type: i === 0 ? 'depart' : 'continue', modifier: 'straight', location: a }, intersections: [{ lanes: [{ valid: true, indications: ['straight'] }, { valid: false, indications: ['right'] }] }] },
        { distance: meters * 0.4, duration: dur * 0.4, name: 'Main Street',
          maneuver: { type: 'turn', modifier: 'right', location: pts[6] }, intersections: [] },
        { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: b }, intersections: [] },
      ];
    }
    legs.push(leg);
  }
  if (record) { firstSteps = coords; firstGeom = geometry; }
  return { code: 'Ok', routes: [{ distance: totalM, duration: totalS, legs, geometry: { coordinates: geometry } }], waypoints: coords.map((c, i) => ({ distance: i === 2 ? 420 : 12, location: c })) };
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.includes('localhost:5199')) return route.continue();
  if (u.includes('router.project-osrm.org')) return route.fulfill({ json: buildOsrm(u) });
  if (u.includes('overpass-api.de')) {
    const g = (firstGeom ?? []).filter((_, i) => i % 2 === 0).map(([lng, lat]) => ({ lat, lon: lng }));
    return route.fulfill({ json: { elements: g.length > 1 ? [{ type: 'way', id: 1, tags: { highway: 'motorway', maxspeed: '75 mph', ref: 'I 90' }, geometry: g }] : [] } });
  }
  return route.abort();
});
await page.addInitScript(() => {
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  Object.defineProperty(window, 'speechSynthesis', { value: { speak: () => {}, cancel: () => {}, resume: () => {}, speaking: false, pending: false }, configurable: true });
  const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: () => {} };
  Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  window.__feed = (lat, lng, heading, mps) => { window.__geoCb?.({ coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() }); };
});

await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.screenshot({ path: SHOT('home') });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForFunction(() => {
  try { return Object.keys(JSON.parse(localStorage.getItem('sturgis.routeCache.v5') || '{}')).length >= 3; } catch { return false; }
}, { timeout: 30000 });
await page.screenshot({ path: SHOT('plan-initial') });
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
await page.screenshot({ path: SHOT('plan-map') });
await page.locator('.rchip').nth(1).click();
await page.waitForSelector('.wp-row', { timeout: 8000 });
await page.screenshot({ path: SHOT('plan-day') });
// trip settings live on the overview panel: first rchip = Trip seat
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);
await page.locator('.rchip').nth(0).click();
await page.waitForTimeout(500);
const paceFld = page.locator('label:has-text("Group pace buffer")');
if (await paceFld.count()) { await paceFld.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); }
await page.screenshot({ path: SHOT('trip-settings') });
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300);
// PREP
await page.locator('.modebar button', { hasText: 'Prep' }).first().click();
await page.waitForTimeout(700);
await page.screenshot({ path: SHOT('prep') });

// RIDE
await page.click('.ride-seat');
await page.waitForSelector('.ride-mode', { timeout: 8000 });
await page.waitForFunction(() => !!window.__geoCb, { timeout: 8000 });
for (let i = 0; i < 30 && !firstSteps; i++) await page.waitForTimeout(300);
const wps = firstSteps;
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) % 360;
const feed = async (p, hdg, mps = 29) => { await page.evaluate(({ lat, lng, hdg, mps }) => window.__feed(lat, lng, hdg, mps), { lat: p[1], lng: p[0], hdg, mps }); await page.waitForTimeout(430); };
{
  const a = wps[0], b = wps[1];
  for (const t of [0.03, 0.06, 0.09, 0.12]) await feed(lerp(a, b, t), bearing(a, b));
}
await page.waitForTimeout(1200);
await page.screenshot({ path: SHOT('ride-detailed') });
// minimal density
await page.click('.ride-bar');
await page.waitForSelector('.ride-sheet', { timeout: 5000 });
await page.locator('.rm-seg button', { hasText: 'Minimalist' }).click();
await page.click('.ride-bar');
await page.waitForTimeout(500);
await page.screenshot({ path: SHOT('ride-minimal') });
// back to detailed
await page.click('.ride-bar');
await page.locator('.rm-seg button', { hasText: 'Detailed' }).click();
await page.click('.ride-bar');
await page.waitForTimeout(400);
// max stack: trigger the pass-by auto-skip so sign + undo + chips + bar coexist
{
  const a = wps[0], b = wps[1];
  const legMi = hav(a, b);
  const near = lerp(a, b, 1 - 0.8 / legMi);
  await feed(near, bearing(a, b));
  const dir = bearing(a, b) + 75; const rad = (dir * Math.PI) / 180;
  let p = near;
  for (let k = 1; k <= 6; k++) {
    p = [p[0] + (0.3 / (69.17 * Math.cos((p[1] * Math.PI) / 180))) * Math.sin(rad), p[1] + (0.3 / 69.17) * Math.cos(rad)];
    await feed(p, dir);
  }
}
await page.waitForTimeout(600);
console.log('undo chip:', await page.locator('.ride-undo').count(), '· sign:', await page.locator('.speed-sign').count(), '· chips:', await page.locator('.ride-chips').count());
await page.screenshot({ path: SHOT('ride-maxstack') });
await browser.close();
console.log('sweep complete');

// Voice + zoom regression sim: stubbed speech engine, scripted fixes, zoom reads.
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

let lastStepsCoords = null;
let lastStepsGeometry = null;
let lastTurnLoc = null; // the mock's mid-leg turn maneuver on leg 0

function buildOsrm(url) {
  const m = /driving\/([^?]+)\?/.exec(url);
  const coords = m[1].split(';').map((p) => p.split(',').map(Number));
  const withSteps = url.includes('steps=true');
  // record only the FIRST steps request (routeDaySteps) — the traffic-anchor
  // routeFrom fires on the first fix and must not clobber the turn location
  const record = withSteps && !lastStepsCoords;
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
      if (record && i === 0) lastTurnLoc = pts[6];
      leg.steps = [
        { distance: meters * 0.6, duration: dur * 0.6, name: 'Interstate 90', ref: 'I 90',
          maneuver: { type: i === 0 ? 'depart' : 'continue', modifier: 'straight', location: a }, intersections: [] },
        { distance: meters * 0.4, duration: dur * 0.4, name: 'Main Street',
          maneuver: { type: 'turn', modifier: 'right', location: pts[6] }, intersections: [] },
        { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: b }, intersections: [] },
      ];
    }
    legs.push(leg);
  }
  if (record) { lastStepsCoords = coords; lastStepsGeometry = geometry; }
  return {
    code: 'Ok',
    routes: [{ distance: totalM, duration: totalS, legs, geometry: { coordinates: geometry } }],
    waypoints: coords.map((c) => ({ distance: 10, location: c })),
  };
}

const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

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
  // recorded speech engine
  window.__spoken = [];
  window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.volume = 1; } };
  Object.defineProperty(window, 'speechSynthesis', {
    value: { speak: (u) => window.__spoken.push(u.text), cancel: () => {}, resume: () => {}, speaking: false, pending: false },
    configurable: true,
  });
  // scripted GPS
  const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: () => {} };
  Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  window.__feed = (lat, lng, heading, mps) => {
    window.__geoCb?.({ coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() });
  };
});

await page.goto('http://localhost:5199/');
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForFunction(() => {
  try { return Object.keys(JSON.parse(localStorage.getItem('sturgis.routeCache.v5') || '{}')).length >= 3; } catch { return false; }
}, { timeout: 30000 });
await page.click('.ride-seat');
await page.waitForSelector('.ride-mode', { timeout: 8000 });
await page.waitForFunction(() => !!window.__geoCb, { timeout: 8000 });
for (let i = 0; i < 30 && !lastStepsCoords; i++) await page.waitForTimeout(300);

// first tap anywhere unlocks the engine (records the muted blank) — on empty
// map, NOT at the mouse's last position (which is the ride-seat → ride-bar)
await page.mouse.move(187, 260);
await page.mouse.down(); await page.mouse.up();
const unlocked = await page.evaluate(() => window.__spoken.length);
check('voice: first tap unlocks the engine', unlocked >= 1, `${unlocked} utterance(s)`);

const wps = lastStepsCoords;
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) % 360;

// cruise mid-leg, far from the turn: zoom should settle at the highway tier 14.3
{
  const a = wps[0], b = wps[1];
  for (const t of [0.05, 0.1, 0.15, 0.2]) {
    const p = lerp(a, b, t);
    await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 29), { lat: p[1], lng: p[0], hdg: bearing(a, b) });
    await page.waitForTimeout(450);
  }
}
await page.waitForTimeout(1300);
const zoomHwy = await page.evaluate(() => window.__rideMap?.getZoom());
check('zoom: highway-speed tier ~14.3', zoomHwy > 14.0 && zoomHwy < 14.6, `zoom ${zoomHwy?.toFixed(2)}`);
await page.screenshot({ path: SHOT('ride-zoom') });

// approach the mid-leg turn: announcements fire, zoom tightens to 16.5
{
  const t = lastTurnLoc;
  const a = wps[0];
  const dir = bearing(a, t);
  // fixes at 1.0, 0.6, 0.25, 0.08 mi short of the turn, on the leg line
  for (const back of [1.0, 0.6, 0.25, 0.08]) {
    const total = hav(a, t);
    const p = lerp(a, t, Math.max(0, 1 - back / total));
    await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 29), { lat: p[1], lng: p[0], hdg: dir });
    await page.waitForTimeout(500);
  }
}
await page.waitForTimeout(1300);
const spoken = await page.evaluate(() => window.__spoken.slice());
const navSpeech = spoken.filter((s) => /mile|Turn|Continue|Merge|exit/i.test(s));
check('voice: turn announcements fire while approaching', navSpeech.length >= 2, JSON.stringify(navSpeech.slice(0, 3)));
const zoomTurn = await page.evaluate(() => window.__rideMap?.getZoom());
check('zoom: tightens into the turn ~16.5', zoomTurn > 16.2, `zoom ${zoomTurn?.toFixed(2)}`);
await page.screenshot({ path: SHOT('ride-zoom-turn') });

// unmute cycle speaks confirmation from the tap
// fab order: compass(0), search(1), mute(2), overview(3)
const fabs = page.locator('.ride-fab');
await fabs.nth(2).click(); // mute
await fabs.nth(2).click(); // unmute → "Voice guidance on."
const confirm = await page.evaluate(() => window.__spoken.includes('Voice guidance on.'));
check('voice: unmute confirms audibly from the tap', confirm);

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);

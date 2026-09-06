// Ride Mode SOP sim: phone width, mocked OSRM/Overpass, scripted GPS fixes.
import { chromium } from '../../node_modules/playwright-core/index.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
const R = 3958.8;
const hav = (a, b) => { // [lng,lat] miles
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180, la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

let lastStepsCoords = null;   // waypoint coords of the most recent steps request
let lastStepsGeometry = null; // full interpolated geometry of that route
let osrmCalls = 0;

// Generic OSRM /route mock: straight legs, 8 interior points each, profile
// speed 25 m/s (the untagged-motorway default the calibration lifts to ~70).
function buildOsrm(url) {
  osrmCalls++;
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
        { distance: meters * 0.6, duration: dur * 0.6, name: 'Interstate 90', ref: 'I 90',
          maneuver: { type: i === 0 ? 'depart' : 'continue', modifier: 'straight', location: a }, intersections: [] },
        { distance: meters * 0.4, duration: dur * 0.4, name: 'Main Street',
          maneuver: { type: 'turn', modifier: 'right', location: pts[6] }, intersections: [] },
        { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', location: b }, intersections: [] },
      ];
    }
    legs.push(leg);
  }
  if (withSteps) { lastStepsCoords = coords; lastStepsGeometry = geometry; }
  return {
    code: 'Ok',
    routes: [{ distance: totalM, duration: totalS, legs, geometry: { coordinates: geometry } }],
    // waypoint index 2 flagged 420 m off the road → the DayPanel off-road tag
    waypoints: coords.map((c, i) => ({ distance: i === 2 ? 420 : 12, location: c })),
  };
}

function overpassBody() {
  const g = lastStepsGeometry ?? [];
  const chain = g.filter((_, i) => i % 2 === 0).map(([lng, lat]) => ({ lat, lon: lng }));
  if (chain.length < 2) return { elements: [] };
  return { elements: [{ type: 'way', id: 1, tags: { highway: 'motorway', maxspeed: '75 mph', ref: 'I 90' }, geometry: chain }] };
}

const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok, extra]); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 375, height: 750 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

// network: localhost passes, OSRM + Overpass mocked, everything else aborted
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.includes('localhost:5199')) return route.continue();
  if (u.includes('router.project-osrm.org')) {
    return route.fulfill({ json: buildOsrm(u) });
  }
  if (u.includes('overpass-api.de')) {
    return route.fulfill({ json: overpassBody() });
  }
  if (u.includes('nominatim.openstreetmap.org')) {
    // a gas station ~85% along the current leg — between the rider and the next stop
    const a = lastStepsCoords?.[0] ?? [-108, 44];
    const b = lastStepsCoords?.[1] ?? [-108.1, 44.1];
    const p = lerp(a, b, 0.85);
    return route.fulfill({ json: [{
      place_id: 777,
      display_name: 'Maverik, Cody, Park County, Wyoming, United States',
      lat: String(p[1] + 0.002), lon: String(p[0] + 0.002),
    }] });
  }
  return route.abort();
});

// scripted GPS
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
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });

// wait for the mocked routing to fill the v2 cache
await page.waitForFunction(() => {
  try { return Object.keys(JSON.parse(localStorage.getItem('sturgis.routeCache.v3') || '{}')).length >= 3; } catch { return false; }
}, { timeout: 30000 });

// 1) cache holds calibrated UNPACED legs: implied speed ≈ 69.8 mph
const implied = await page.evaluate(() => {
  const c = JSON.parse(localStorage.getItem('sturgis.routeCache.v3'));
  const out = [];
  for (const day of Object.values(c)) {
    for (const leg of Object.values(day.legs ?? {})) {
      if (leg.miles > 30) out.push(leg.miles / (leg.seconds / 3600));
    }
  }
  return out.slice(0, 5);
});
check('cache: calibrated leg speeds ~70 mph', implied.length > 0 && implied.every((v) => v > 66 && v < 74), implied.map((v) => v.toFixed(1)).join(','));

// 2) off-road pin tag in the day panel
await page.locator('.panel-scrim').click({ force: true, timeout: 3000 }).catch(() => {}); await page.waitForTimeout(400);// fold the open panel first
await page.waitForTimeout(400);
await page.locator('.rchip').nth(1).click(); // a DAY chip (index 0 is the Trip seat)
await page.waitForSelector('.wp-row', { timeout: 8000 });
const offroad = await page.locator('.tag.offroad').count();
check('day panel: off-road pin tag renders', offroad >= 1, `${offroad} tag(s)`);
await page.screenshot({ path: SHOT('plan-panel'), fullPage: false });

// 3) into Ride Mode
await page.click('.ride-seat');
await page.waitForSelector('.ride-mode', { timeout: 8000 });
// steps request lands (google-route 501s first, then mocked OSRM)
await page.waitForFunction(() => !!window.__geoCb, { timeout: 8000 });
for (let i = 0; i < 30 && !lastStepsCoords; i++) await page.waitForTimeout(300);
check('ride: turn-by-turn steps fetched', !!lastStepsCoords);

const wps = lastStepsCoords; // [lng,lat][]
const geom = lastStepsGeometry;
const bearing = (a, b) => ((Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI + 360) % 360;

// ride the first leg: fixes along the geometry, stopping ~1.4 mi short of wp1
const leg0 = [];
{
  const a = wps[0], b = wps[1];
  const legMi = hav(a, b);
  const stopT = Math.max(0.1, 1 - 1.4 / legMi);
  for (let t = 0.02; t <= stopT; t += stopT / 7) leg0.push(lerp(a, b, t));
}
for (const p of leg0) {
  const nxt = wps[1];
  await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 29), { lat: p[1], lng: p[0], hdg: bearing(p, nxt) });
  await page.waitForTimeout(420);
}

// bar: leg countdown is the big number, day line demoted, speed sign up
await page.waitForSelector('.turn-card', { timeout: 8000 });
const rbBig = await page.locator('.rb-big').first().textContent();
check('ride bar: big number is a duration (leg countdown)', /^\s*(\d+h \d{2}m|\d+m)\s*$/.test(rbBig ?? ''), JSON.stringify(rbBig));
const rbMid = await page.locator('.rb-mid').first().textContent();
check('ride bar: leg ETA clock + miles beside it', /(AM|PM)/.test(rbMid ?? '') && /(mi|km)/.test(rbMid ?? ''), JSON.stringify(rbMid));
const rbDay = await page.locator('.rb-day').count();
check('ride bar: day ETA demoted to its own line', rbDay === 1);
await page.waitForSelector('.speed-sign', { timeout: 15000 });
const signNum = await page.locator('.speed-sign .ss-num').textContent();
check('speed sign: posted 75 shown', signNum?.trim() === '75', JSON.stringify(signNum));
await page.screenshot({ path: SHOT('ride-nav') });

// 4) the sheet: stop cards carry Go next / Skip; skip → dimmed + Restore
await page.click('.ride-bar');
await page.waitForSelector('.ride-sheet', { timeout: 5000 });
const actionBtns = await page.locator('.stop-card .sc-actions button').count();
check('sheet: stop cards have destination controls', actionBtns >= 2, `${actionBtns} buttons`);
await page.screenshot({ path: SHOT('ride-sheet') });
const callsBefore = osrmCalls;
await page.locator('.stop-card .sc-actions button', { hasText: 'Skip' }).first().click();
await page.waitForSelector('.stop-card.skipped', { timeout: 8000 });
for (let i = 0; i < 20 && osrmCalls === callsBefore; i++) await page.waitForTimeout(250);
check('sheet: Skip dims the card and reroutes', osrmCalls > callsBefore, `osrm calls ${callsBefore}→${osrmCalls}`);
await page.screenshot({ path: SHOT('ride-skip') });
await page.locator('.stop-card.skipped .sc-actions button', { hasText: 'Restore' }).first().click();
await page.waitForTimeout(1200);
const stillSkipped = await page.locator('.stop-card.skipped').count();
check('sheet: Restore brings the stop back', stillSkipped === 0);

// 4b) mid-ride search (rider is mid-leg, station mocked ~85% along it):
// adding a fuel stop slots it into the current leg and retargets nav
await page.waitForSelector('.ride-search', { timeout: 5000 });
await page.fill('.ride-search', 'Maverik Cody');
await page.waitForSelector('.rs-row', { timeout: 15000 });
const callsB4 = osrmCalls;
await page.locator('.rs-row .rs-fuel').first().click();
await page.waitForTimeout(1500);
const nextName = await page.locator('.rb-next .mq-seg').first().textContent();
check('search: added fuel stop becomes the next destination', /Maverik/i.test(nextName ?? ''), JSON.stringify(nextName));
check('search: adding rerouted nav', osrmCalls > callsB4, `osrm ${callsB4}→${osrmCalls}`);
await page.screenshot({ path: SHOT('ride-search') });

// 5) pass-by auto-skip: approach wp1 to ~0.8 mi, then veer away on a diverging
// line — nav should skip it, announce, and offer UNDO
{
  const a = wps[0], b = wps[1];
  const legMi = hav(a, b);
  const near = lerp(a, b, 1 - 0.8 / legMi); // 0.8 mi short of the stop
  await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 29), { lat: near[1], lng: near[0], hdg: bearing(a, b) });
  await page.waitForTimeout(450);
  // diverge: rotate the remaining direction ~75° and keep riding
  const dir = bearing(a, b) + 75;
  const rad = (dir * Math.PI) / 180;
  let p = near;
  for (let k = 1; k <= 6; k++) {
    const stepMi = 0.3;
    const dLat = (stepMi / 69.17) * Math.cos(rad);
    const dLng = (stepMi / (69.17 * Math.cos((p[1] * Math.PI) / 180))) * Math.sin(rad);
    p = [p[0] + dLng, p[1] + dLat];
    await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 29), { lat: p[1], lng: p[0], hdg: dir });
    await page.waitForTimeout(450);
  }
}
const undoVisible = await page.locator('.ride-undo').count();
check('auto-skip: passed-by stop skipped, UNDO chip up', undoVisible === 1);
await page.screenshot({ path: SHOT('ride-undo') });
if (undoVisible) {
  await page.click('.ride-undo');
  await page.waitForTimeout(800);
  check('auto-skip: UNDO restores the stop', (await page.locator('.ride-undo').count()) === 0);
}

// 6) arrival: land on the final stop
{
  const last = wps[wps.length - 1];
  const prev = wps[wps.length - 2];
  for (let k = 0; k < 3; k++) {
    await page.evaluate(({ lat, lng, hdg }) => window.__feed(lat, lng, hdg, 4), { lat: last[1], lng: last[0], hdg: bearing(prev, last) });
    await page.waitForTimeout(450);
  }
}
await page.waitForSelector('.ride-bar.arrive', { timeout: 8000 });
check('arrival: bar swaps to Arrived state', true);
await page.screenshot({ path: SHOT('ride-arrived') });

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);

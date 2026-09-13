// The nearby / swap picker: category browse along the route, rows that carry
// rating · price · off-route miles · open-at-ETA, a swap that keeps the stop's
// ROLE, a meal swap, and the Ride Mode "add ahead" door landing a fuel stop.
//
// nearby-places is mocked with a fixed set of places whose hours are chosen so
// the open-at-ETA badge has something to decide. Valhalla is mocked so the day
// has a routed line to be "along". Everything else is aborted.
//
//   npm run dev    # :5199
//   node tools/sims/nearby-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';

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

// A straight road A(−108.00,44.00) → B(−107.95,44.06) → C(−107.88,44.10).
const A = [-108.0, 44.0], B = [-107.95, 44.06], C = [-107.88, 44.10];
function valhalla(body) {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i], b = locs[i + 1];
    const pts = [a, lerp(a, b, 0.5), b];
    const mi = 5, sec = 360;
    legs.push({ shape: enc6(pts), summary: { length: mi, time: sec }, maneuvers: [
      { type: 1, instruction: 'Ride.', street_names: ['Road'], length: mi, time: sec, begin_shape_index: 0 },
      { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2 },
    ] });
  }
  return { trip: { legs, summary: { length: 5 * legs.length, time: 360 * legs.length }, status: 0, units: 'miles' } };
}

// Places: two on the line (one open all day, one closed by 2pm), one 6 miles off it
// to the north, one behind the start.
const on1 = lerp(A, B, 0.3), on2 = lerp(A, B, 0.7), off = [lerp(A, B, 0.5)[0], lerp(A, B, 0.5)[1] + 0.09], behind = [A[0] - 0.05, A[1] - 0.02];
const allDay = [{ open: { day: 0, hour: 0, minute: 0 } }];
const early = Array.from({ length: 7 }, (_, d) => ({ open: { day: d, hour: 6, minute: 0 }, close: { day: d, hour: 14, minute: 0 } }));
let nearbyCalls = [];
function places(body) {
  nearbyCalls.push(body);
  const cat = body.category;
  const mk = (id, name, [lng, lat], extra) => ({ id, name, detail: `${name} Rd, Granite WY`, lat, lng, rating: 4.4, userRatingCount: 120, priceLevel: 'PRICE_LEVEL_MODERATE', status: 'OPERATIONAL', hours: ['Mon: 6 AM–2 PM'], periods: allDay, openNow: true, googleMapsUri: 'https://maps.google.com/?q=x', ...extra });
  if (cat === 'fuel') return [mk('g1', 'Sinclair Granite', on1, { rating: 4.1 }), mk('g2', 'Exxon Ridge', on2), mk('g3', 'Maverik North', off)];
  if (cat === 'food') return [mk('f1', 'Ridge Diner', on2, { periods: early, openNow: false }), mk('f2', 'Basecamp Grill', on1), mk('f3', 'Old Mill Cafe', behind)];
  if (cat === 'coffee') return [mk('c1', 'Granite Roasters', on1)];
  return [mk('x1', 'Somewhere', on1)];
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: places(r.request().postDataJSON()) });
  if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
  if (u.includes('localhost:5199')) return r.continue();
  if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
  if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
  return r.abort();
});
await page.addInitScript(() => {
  const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: (cb) => { if (window.__lastFix) cb(window.__lastFix); } };
  Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  window.__feed = (lat, lng, heading, mps) => { window.__lastFix = { coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() }; window.__geoCb?.(window.__lastFix); };
});
await page.goto('http://localhost:5199/');
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const mk = (id, name, lat, lng, extra = {}) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '', ...extra });
  window.__dispatch({
    type: 'create_trip', name: 'NEARBY TEST',
    trip: {
      meta: { title: 'NEARBY TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
      days: [{
        id: 'n1', dow: 'Wed', date: '2026-08-12', title: 'Picker day', phase: 'rally',
        miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [],
        gates: [{ waypointId: 'nb', by: '4:00 PM', label: 'Cabin check-in' }],
        meals: [{ meal: 'lunch', name: 'AI Pick Diner', where: 'somewhere', note: '', alt: '' }],
        photos: [], modules: [], ops: [], lodging: { status: 'none', name: '', where: '', note: '' },
        waypoints: [mk('na', 'Basecamp', 44.0, -108.0), mk('nb', 'Granite Diner', 44.06, -107.95, { dwell: 45, kind: 'via' }), mk('nc', 'End Lodge', 44.10, -107.88)],
      }],
    },
  });
});
await page.waitForTimeout(1200);
const lib = () => page.evaluate(() => { const l = JSON.parse(localStorage.getItem('moto.trips.v1')); return l.trips.find((r) => r.id === l.activeId).trip; });

// open the day panel
if (await page.locator('.main').getAttribute('data-panel') === 'closed') {
  await page.locator('.modebar button', { hasText: 'Plan' }).evaluate((el) => el.click());
  await page.waitForFunction(() => document.querySelector('.main')?.dataset.panel === 'open');
}
await page.locator('.ribbon .rchip:not(.trip-seat)').first().click();
await page.waitForSelector('.wp-row', { timeout: 8000 });

// ---- 1. the add door: chips, along-route facts ----
await page.locator('.place-search .btn').click();
await page.waitForSelector('.nearby', { timeout: 5000 });
check(await page.locator('.nb-chip').count() === 7, 'seven category chips');
await page.locator('.nb-chip', { hasText: 'Fuel' }).click();
await page.waitForSelector('.nb-item', { timeout: 6000 });
const fuelReq = nearbyCalls.at(-1);
check(fuelReq.category === 'fuel' && Array.isArray(fuelReq.route) && fuelReq.route.length > 1, `fuel chip searched ALONG the routed line (${fuelReq.route?.length} vertices sent)`);
const rows = await page.locator('.nb-item').allTextContents();
check(rows.length === 3, `three fuel rows (${rows.length})`);
check(rows.some((r) => /★ 4\.1/.test(r)) && rows.some((r) => /\$\$/.test(r)), 'rows carry rating and price');
const offRow = rows.find((r) => /Maverik North/.test(r));
const offMi = Number((offRow || '').match(/([\d.]+) mi off route/)?.[1]);
check(offMi >= 3 && offMi <= 7, `an off-line place says how far off the road it is (${offMi} mi; 0.09° north of a NE-running line)`);
const onRow = rows.find((r) => /Sinclair/.test(r));
check(onRow && /(^|\D)0(\.0)? mi off route/.test(onRow), 'a place on the line reads 0 mi off route');
await page.screenshot({ path: SHOT('nearby-add') });
// add Exxon as a fuel stop
await page.locator('.nb-item', { hasText: 'Exxon Ridge' }).locator('.nb-main').click();
await page.waitForSelector('.nb-actions', { timeout: 4000 });
await page.locator('.nb-actions .btn.gold').click();
await page.waitForTimeout(500);
let trip = await lib();
const exxon = trip.days[0].waypoints.find((w) => w.name === 'Exxon Ridge');
check(exxon && exxon.kind === 'fuel' && exxon.fuel === true && exxon.placeId === 'g2' && exxon.verified === 'google', 'the fuel-chip pick lands as a verified fuel stop with place identity');
const idx = trip.days[0].waypoints.findIndex((w) => w.id === exxon.id);
check(idx === 1, `inserted by route order — between Basecamp and Granite Diner (index ${idx})`);

// ---- 2. swap keeps the role ----
const diner = page.locator('.wp-row', { hasText: 'Granite Diner' });
await diner.locator('.rm.swap').click();
await page.waitForSelector('.nearby-swap', { timeout: 5000 });
check(await page.locator('.nearby-swap .nb-chip.active').textContent() === '🍽Food', 'swap opens on the Food chip for a diner');
await page.waitForSelector('.nearby-swap .nb-item', { timeout: 6000 });
const swapRows = await page.locator('.nearby-swap .nb-item').allTextContents();
const ridge = swapRows.find((r) => /Ridge Diner/.test(r));
const grill = swapRows.find((r) => /Basecamp Grill/.test(r));
// arrival at Granite Diner is ~9:00 + two 6-min legs ≈ 9:12 → Ridge Diner (6–14) is open; badge must read at-your-ETA, not now
check(ridge && /Open at your ETA/.test(ridge), `open-at-ETA is judged against the stop's arrival ("${(ridge || '').match(/(Open|Closed) at your ETA/)?.[0]}")`);
check(grill && /Open at your ETA/.test(grill), 'all-day place reads open at your ETA');
const oldMill = swapRows.find((r) => /Old Mill/.test(r));
const fromStop = Number((oldMill || '').match(/([\d.]+) mi from this stop/)?.[1]);
check(fromStop >= 3, `swap rows measure road distance FROM the stop being replaced, not ahead/behind (${fromStop} mi)`);
check(!/behind you/.test(swapRows.join(' ')), 'no swap row says "behind you"');
await page.locator('.nearby-swap .nb-item', { hasText: 'Ridge Diner' }).locator('.nb-main').click();
await page.waitForSelector('.nearby-swap .nb-actions', { timeout: 4000 });
await page.waitForTimeout(900); // the detour measurement
const detourTxt = await page.locator('.nearby-swap .nb-detour').textContent().catch(() => '');
check(/\+\d+ min/.test(detourTxt), `the expanded row measured a real detour via Valhalla ("${detourTxt.trim().slice(0, 40)}")`);
await page.screenshot({ path: SHOT('nearby-swap') });
await page.locator('.nearby-swap .nb-actions .btn.gold').click();
await page.waitForTimeout(500);
trip = await lib();
const swapped = trip.days[0].waypoints.find((w) => w.id === 'nb');
check(swapped.name === 'Ridge Diner' && swapped.placeId === 'f1' && swapped.verified === 'google', 'the stop now IS the picked place');
check(swapped.dwell === 45 && swapped.kind === 'via', 'dwell and kind survive the swap');
check(trip.days[0].gates[0].waypointId === 'nb', 'the gate on that stop still points at it');
check(trip.days[0].waypoints.length === 4, 'no stop was added or removed by the swap');

// ---- 3. meal swap ----
await page.locator('.meal .mini-edit.swap').first().click();
await page.waitForSelector('.meal .nearby-swap .nb-item', { timeout: 6000 });
await page.locator('.meal .nearby-swap .nb-item', { hasText: 'Basecamp Grill' }).locator('.nb-main').click();
await page.locator('.meal .nearby-swap .nb-actions .btn.gold').click();
await page.waitForTimeout(500);
trip = await lib();
const lunch = trip.days[0].meals.find((m) => m.meal === 'lunch');
check(lunch.name === 'Basecamp Grill' && lunch.placeId === 'f2' && lunch.verified === 'google', 'lunch swapped to a verified place');

// ---- 4. Ride Mode: add ahead, from the bike, fuel by default ----
await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForTimeout(600);
const [lng0, lat0] = lerp(A, B, 0.1);
await page.evaluate(([a, b]) => window.__feed(a, b, 40, 18), [lat0, lng0]);
await page.waitForTimeout(500);
nearbyCalls = [];
await page.locator('.ride-fab[aria-label="Add a stop ahead"]').click();
await page.waitForSelector('.ride-sheet .nearby', { timeout: 5000 });
await page.waitForSelector('.ride-sheet .nb-item', { timeout: 6000 });
const rideReq = nearbyCalls.at(-1);
check(rideReq.category === 'fuel' && Math.abs(rideReq.near.lat - lat0) < 0.01, 'Ride opens on Fuel, searching from the bike');
const rideRows = await page.locator('.ride-sheet .nb-item').allTextContents();
check(rideRows.some((r) => /ahead/.test(r)), 'ride rows say how far ahead each place is');
await page.locator('.ride-sheet .nb-item', { hasText: 'Sinclair' }).locator('.nb-main').click();
await page.locator('.ride-sheet .nb-actions .btn.gold').click();
await page.waitForTimeout(700);
trip = await lib();
const sinclair = trip.days[0].waypoints.find((w) => w.name === 'Sinclair Granite');
check(sinclair && sinclair.fuel === true && sinclair.kind === 'fuel', 'mid-ride pick landed as a fuel stop');
await page.screenshot({ path: SHOT('nearby-ride') });

console.log(`\n${pass}/${pass + fail} passed`);
await browser.close();
process.exit(fail ? 1 : 0);

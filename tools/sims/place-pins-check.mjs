// Place pins: the picker's candidates as REAL pins on the map.
//
//   · every result is a pin with a glyph and a name, on the plan map
//   · the expanded row is the hot pin; tapping a pin expands its row and
//     scrolls the list to it (same selection both ways)
//   · a new result set frames the map around its pins
//   · on a phone the panel drops to a half sheet so the pins are above it
//   · panning offers "Search this area"; pressing it searches the map centre
//   · Ride Mode's quick add draws its three cards as pins on the nav map
//   · the Google tile session asks for no baked POI icons
//
//   npm run dev    # :5199
//   node tools/sims/place-pins-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { pinGooglePlaces } from './fixtures/google-places.mjs';
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
const A = [-108.0, 44.0], B = [-107.95, 44.06], C = [-107.88, 44.10];
function valhalla(body) {
  const locs = body.locations.map((l) => [l.lon, l.lat]);
  const legs = [];
  for (let i = 0; i < locs.length - 1; i++) {
    const a = locs[i], b = locs[i + 1];
    legs.push({ shape: enc6([a, lerp(a, b, 0.5), b]), summary: { length: 5, time: 360 }, maneuvers: [
      { type: 1, instruction: 'Ride.', street_names: ['Road'], length: 5, time: 360, begin_shape_index: 0 },
      { type: 4, instruction: 'Arrive.', length: 0, time: 0, begin_shape_index: 2 },
    ] });
  }
  return { trip: { legs, summary: { length: 5 * legs.length, time: 360 * legs.length }, status: 0, units: 'miles' } };
}
const on1 = lerp(A, B, 0.3), on2 = lerp(A, B, 0.7), on3 = lerp(B, C, 0.5);
const allDay = [{ open: { day: 0, hour: 0, minute: 0 } }];
let calls = [];
function places(body) {
  calls.push(body);
  const mk = (id, name, [lng, lat]) => ({ id, name, detail: `${name} Rd`, lat, lng, rating: 4.4, userRatingCount: 50, status: 'OPERATIONAL', periods: allDay, openNow: true, primaryType: body.category === 'fuel' ? 'gas_station' : 'restaurant', types: [] });
  // a search around a map centre answers with places AT that centre
  if (body.near && Math.abs(body.near.lat - 44.30) < 0.05) return [mk('z1', 'Far North Fuel', [body.near.lng, body.near.lat]), mk('z2', 'North Ridge Gas', [body.near.lng + 0.02, body.near.lat + 0.01])];
  if (body.category === 'fuel') return [mk('g1', 'Sinclair Granite', on1), mk('g2', 'Exxon Ridge', on2), mk('g3', 'Cenex Summit', on3)];
  return [mk('f1', 'Ridge Diner', on2), mk('f2', 'Basecamp Grill', on1)];
}

// 0. the tile session drops Google's baked POI icons (and still the road shields)

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  const page = await ctx.newPage(); await pinGooglePlaces(page); // mocks Google's place functions
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
    window.__spoken = [];
    const fakeSynth = { speak: (u) => window.__spoken.push(u.text), cancel() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(window, 'speechSynthesis', { value: fakeSynth, configurable: true });
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    window.SpeechRecognition = window.webkitSpeechRecognition = function () { this.start = () => {}; this.abort = () => {}; this.stop = () => {}; };
    const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: (cb) => { if (window.__lastFix) cb(window.__lastFix); } };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
    window.__feed = (lat, lng, heading, mps) => { window.__lastFix = { coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() }; window.__geoCb?.(window.__lastFix); };
  });
  await seedRideAck(page); // Ride Mode's safety gate is answered once per device
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.trip-card', { timeout: 15000 });
  { const tb = page.locator('.hm-tripsbtn'); if (await tb.isVisible().catch(() => false)) { await tb.click(); await page.waitForTimeout(400); } } // the desktop home keeps the library in a closed drawer
  await page.click('.trip-card');
  await page.waitForSelector('.modebar', { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const mk = (id, name, lat, lng, extra = {}) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '', ...extra });
    window.__dispatch({
      type: 'create_trip', name: 'PINS TEST',
      trip: {
        meta: { title: 'PINS TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
        days: [{
          id: 'p1', dow: 'Wed', date: '2026-08-12', title: 'Pins day', phase: 'outbound',
          miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
          lodging: { status: 'none', name: '', where: '', note: '' },
          waypoints: [mk('pa', 'Basecamp', 44.0, -108.0), mk('pb', 'Granite Diner', 44.06, -107.95, { dwell: 30 }), mk('pc', 'End Lodge', 44.10, -107.88)],
        }],
      },
    });
  });
  await page.waitForTimeout(1000);
  if (phone && await page.locator('.main').getAttribute('data-panel') === 'closed') {
    await page.locator('.modebar button', { hasText: 'Plan' }).evaluate((el) => el.click());
    await page.waitForFunction(() => document.querySelector('.main')?.dataset.panel === 'open');
  }
  await page.locator('.ribbon .rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.wp-row', { timeout: 8000 });
  const mapBox = async () => page.locator('.map-wrap').boundingBox();

  // 1. pins with glyph + name
  await page.locator('.place-search .btn').click();
  await page.waitForSelector('.nearby', { timeout: 5000 });
  await page.locator('.nb-chip', { hasText: 'Fuel' }).click();
  await page.waitForSelector('.nb-item', { timeout: 6000 });
  const gotPins = await page.waitForFunction(() => document.querySelectorAll('.pl-pin').length === 3, null, { timeout: 8000 }).then(() => true).catch(() => false);
  if (!gotPins) console.log('DEBUG pins', await page.evaluate(() => ({ pins: document.querySelectorAll('.pl-pin').length, items: document.querySelectorAll('.nb-item').length, labels: [...document.querySelectorAll('.pl-label')].map((l) => l.textContent), panel: document.querySelector('.main')?.dataset.panel })));
  const pins = page.locator('.pl-pin');
  check(await pins.count() === 3, 'three results → three pins on the plan map');
  const labels = await pins.locator('.pl-label').allTextContents();
  check(labels.includes('Sinclair Granite') && labels.includes('Exxon Ridge'), `pins carry names (${labels.join(' · ')})`);
  const glyphs = await pins.locator('.pl-glyph').allTextContents();
  check(glyphs.every((g) => g === '⛽'), 'and the category glyph');
  check(await page.locator('.pl-pin[aria-label]').count() === 3, 'pins are buttons with names for a screen reader');

  // 2. framed: after the fit every pin is inside the map, clear of the panel
  await page.waitForTimeout(900);
  const mb = await mapBox();
  const side = await page.locator('.side').boundingBox();
  let inside = 0;
  for (let i = 0; i < 3; i++) {
    const b = await pins.nth(i).boundingBox();
    const clearOfPanel = phone ? b.y + b.height <= side.y + 2 : true;
    if (b && b.x >= mb.x && b.x + b.width <= mb.x + mb.width && b.y >= mb.y && clearOfPanel) inside++;
  }
  check(inside === 3, `the map framed the results: ${inside}/3 pins on screen${phone ? ' above the half sheet' : ''}`);
  if (phone) {
    check(await page.locator('.main').getAttribute('data-panel') === 'half', 'phone: the panel dropped to a half sheet');
    check(side.height <= 0.56 * 800 && side.y >= 0.4 * 800, `the sheet is the lower half (top at ${Math.round(side.y)}px of 800)`);
    check(await page.locator('.panel-scrim').count() === 0, 'no scrim over the live map');
    const nb = await page.locator('.nearby').boundingBox();
    check(nb.y >= side.y - 4 && nb.y <= side.y + 120, `the picker sits at the top of the sheet (${Math.round(nb.y - side.y)}px below its edge)`);
  }
  await page.screenshot({ path: SHOT(`place-pins-${width}`) });

  // 3. row → hot pin; pin → row
  await page.locator('.nb-item', { hasText: 'Exxon Ridge' }).locator('.nb-main').click();
  await page.waitForSelector('.pl-pin.hot', { timeout: 3000 });
  check((await page.locator('.pl-pin.hot .pl-label').textContent()) === 'Exxon Ridge', 'expanding a row lights its pin');
  await page.locator('.pl-pin', { hasText: 'Sinclair Granite' }).click();
  await page.waitForFunction(() => document.querySelector('.nb-item.open')?.textContent.includes('Sinclair Granite'), null, { timeout: 4000 });
  check(true, 'tapping a pin expands that row');
  check((await page.locator('.pl-pin.hot .pl-label').textContent()) === 'Sinclair Granite', 'and the hot pin follows');
  const openRow = await page.locator('.nb-item.open').boundingBox();
  check(openRow && openRow.y >= side.y - 2 && openRow.y + 40 <= side.y + side.height, 'the list scrolled so that row is visible');
  check(await page.locator('.modal, .sheet-add, .add-stop').count() === 0 || !(await page.locator('.modal-backdrop').isVisible().catch(() => false)), 'a pin tap never doubles as click-to-add on the map');
  await page.screenshot({ path: SHOT(`place-pins-tap-${width}`) });

  // 4. pan → "Search this area" → searches the map centre
  check(await page.locator('.map-area-btn').count() === 0, 'no area button before the rider pans');
  await page.evaluate(() => window.__map?.panBy([0, -400], { duration: 0 }));
  await page.waitForTimeout(300);
  check(await page.locator('.map-area-btn').count() === 0, 'a programmatic move does not offer it');
  const m = await mapBox();
  // drag from a point that is bare canvas (not a pin, not the hint, not the sheet)
  const spot = await page.evaluate(([x0, y0, w, h]) => {
    for (const fy of [0.35, 0.25, 0.45, 0.15]) for (const fx of [0.3, 0.5, 0.7]) {
      const x = x0 + w * fx, y = y0 + h * fy;
      if (document.elementFromPoint(x, y)?.classList.contains('mapboxgl-canvas')) return [x, y];
    }
    return null;
  }, [m.x, m.y, m.width, m.height]);
  check(!!spot, 'there is bare map to pan on');
  const [cx, cy] = spot ?? [m.x + m.width / 2, m.y + 140];
  await page.evaluate(() => { window.__ev = []; window.__map?.on('moveend', (e) => window.__ev.push(['moveend', !!e.originalEvent])); window.__map?.on('dragend', () => window.__ev.push(['dragend'])); });
  const c0 = await page.evaluate(() => window.__map?.getCenter().toArray());
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx, cy + 40, { steps: 6 }); await page.mouse.move(cx, cy + 90, { steps: 6 }); await page.mouse.up();
  const ok = await page.waitForSelector('.map-area-btn', { timeout: 4000 }).then(() => true).catch(() => false);
  if (!ok) console.log('DEBUG drag', { spot, c0, c1: await page.evaluate(() => window.__map?.getCenter().toArray()), ev: await page.evaluate(() => window.__ev), active: await page.evaluate(() => window.__state?.pickerActive) });
  check(ok, 'a hand pan offers "Search this area"');
  await page.evaluate(() => window.__map?.jumpTo({ center: [-107.9, 44.30], zoom: 11 }));
  // jumpTo has no originalEvent; the button is still up from the drag
  calls = [];
  await page.locator('.map-area-btn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.pl-label')].some((l) => /Far North/.test(l.textContent)), null, { timeout: 6000 });
  const req = calls.at(-1);
  check(req && Math.abs(req.near.lat - 44.30) < 0.01 && Math.abs(req.near.lng + 107.9) < 0.01 && !req.route, `the search is centred on the map (${req?.near.lat.toFixed(2)}, ${req?.near.lng.toFixed(2)}), not the route`);
  check(await page.locator('.nb-scope button.active').textContent() === 'Map area', 'the picker shows a Map area scope');
  check(await page.locator('.map-area-btn').count() === 0, 'and the button goes away until the next pan');
  await page.locator('.nearby .mini-edit').click();
  await page.waitForFunction(() => document.querySelectorAll('.pl-pin').length === 0, null, { timeout: 4000 });
  check(true, 'closing the picker clears the pins');
  if (phone) check(await page.locator('.main').getAttribute('data-panel') === 'open', 'and the panel is a full panel again');

  // 5. Ride Mode: the quick add's cards are pins on the nav map
  if (phone) await page.locator('.panel-tab').click().catch(() => {});
  await page.locator('.modebar button', { hasText: /ride/i }).click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  await page.waitForTimeout(600);
  const [lng0, lat0] = lerp(A, B, 0.1);
  await page.evaluate(([a, b]) => window.__feed(a, b, 40, 18), [lat0, lng0]);
  await page.waitForTimeout(500);
  await page.locator('.ride-fab[aria-label="Add a stop ahead"]').click();
  await page.waitForSelector('.rqa', { timeout: 5000 });
  await page.locator('.rqa-big', { hasText: 'Fuel' }).click();
  await page.waitForSelector('.rqa-card', { timeout: 6000 });
  const gotRide = await page.waitForFunction(() => document.querySelectorAll('.ride-mode .pl-pin.pl-ride').length >= 2, null, { timeout: 4000 }).then(() => true).catch(() => false);
  if (!gotRide) console.log('DEBUG ride', await page.evaluate(() => ({ any: document.querySelectorAll('.pl-pin').length, ride: document.querySelectorAll('.pl-pin.pl-ride').length, inRide: document.querySelectorAll('.ride-mode .pl-pin').length, rideEls: document.querySelectorAll('.ride-mode').length, cards: document.querySelectorAll('.rqa-card').length, canvases: document.querySelectorAll('.mapboxgl-canvas').length, rideMapCanvas: !!window.__rideMap?.getCanvas()?.isConnected, loaded: window.__rideMap?.loaded?.(), styleLoaded: window.__rideMap?.isStyleLoaded?.() })));
  const ridePins = await page.locator('.ride-mode .pl-pin.pl-ride').count();
  const cards = await page.locator('.rqa-card').count();
  check(ridePins === cards, `the ${cards} cards are ${ridePins} pins on the nav map`);
  const rp = await page.locator('.ride-mode .pl-pin.pl-ride .pl-glyph').first().boundingBox();
  check(rp.width >= 44 && rp.height >= 44, `ride pins are glove-sized (${Math.round(rp.width)}×${Math.round(rp.height)})`);
  await page.screenshot({ path: SHOT(`place-pins-ride-${width}`) });
  await page.locator('.rqa-card').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.ride-mode .pl-pin').length === 0, null, { timeout: 4000 });
  check(true, 'adding the stop clears the pins');
  await ctx.close();
}

const only = process.env.ONLY;
if (!only || only === '375') await run(375, 'phone');
if (!only || only === '1280') await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// A long press (or right-click) on open map DROPS A PIN, on both maps
// (owner, Sep 13 2026): the coordinate opens the same place card as a
// PLACED spot — `placed: 'rider'`, never dressed up as a listing — named
// by its road and town (reverse-geocode, mocked here), offering Ride here /
// Add to a trip on the home and Add to this day on the trip map. A plain
// tap must NOT drop a pin: on a phone a tap is how you dismiss.
//
// Pure first (the gesture helper over a fake map, the label parsers), then
// the browser at 375 (touch + mobile) and 1280. Mapbox, Places, Valhalla,
// reverse-geocode are mocked.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/pin-drop-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';
import { attachLongPress, HOLD_MS, SWALLOW_MS } from '../../src/engine/mapGestures.js';
import { labelFromGeocode, labelFromNearby } from '../../netlify/functions/reverse-geocode.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://localhost:${PORT}`;
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

// ---------------------------------------------------------------- pure: the gesture
{
  // a map-shaped stub: an EventTarget container, a canvas with a rect, a clock we own
  let clock = 1000;
  const now = () => clock;
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
  const container = new EventTarget();
  const mapEvents = {};
  const map = {
    on: (k, fn) => { (mapEvents[k] ??= []).push(fn); },
    off: (k, fn) => { mapEvents[k] = (mapEvents[k] ?? []).filter((f) => f !== fn); },
    fire: (k, e) => (mapEvents[k] ?? []).forEach((f) => f(e)),
    getCanvasContainer: () => container,
    getCanvas: () => canvas,
    unproject: ([x, y]) => ({ lng: x / 100, lat: y / 100 }),
  };
  const fired = [];
  const lp = attachLongPress(map, (pt) => fired.push(pt), { now, hold: 30 });
  // pointer events, as iOS delivers them (touchstart arrives ~550 ms late there — see mapGestures.js)
  // `ts` is the event's own timeStamp (the hardware time); the dispatch clock is `clock`
  const ptr = (type, x, y, { target = canvas, id = 1, pointerType = 'touch', ts = clock } = {}) => {
    const ev = new Event(type);
    Object.defineProperty(ev, 'target', { value: target });
    Object.defineProperty(ev, 'timeStamp', { value: ts });
    Object.assign(ev, { pointerId: id, pointerType, clientX: x, clientY: y, isPrimary: id === 1 });
    container.dispatchEvent(ev);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // a tap: down, up before the hold — nothing
  ptr('pointerdown', 110, 220); ptr('pointerup', 110, 220); await sleep(50);
  check(fired.length === 0, 'a tap (released before the hold) drops nothing');
  // a hold: fires once, at the finger, in map coordinates
  ptr('pointerdown', 110, 220); await sleep(50);
  check(fired.length === 1 && fired[0].lng === 1 && fired[0].lat === 2, `a held finger fires once at the finger (${JSON.stringify(fired[0])})`);
  check(lp.recent(), 'and the click that trails it is flagged as not-a-tap');
  clock += SWALLOW_MS + 1;
  check(!lp.recent(), `…for ${SWALLOW_MS} ms only`);
  ptr('pointerup', 110, 220);
  // a pan: the finger travels past the slop → cancelled
  ptr('pointerdown', 110, 220); ptr('pointermove', 140, 220); await sleep(50); ptr('pointerup', 140, 220);
  check(fired.length === 1, 'a finger that travels (a pan) never drops');
  // a pinch: a second finger → cancelled
  ptr('pointerdown', 110, 220); ptr('pointerdown', 150, 260, { id: 2 }); await sleep(50); ptr('pointerup', 110, 220); ptr('pointerup', 150, 260, { id: 2 });
  check(fired.length === 1, 'a second finger (a pinch) never drops');
  // the map moved under a held finger (mapbox's own movestart) → cancelled
  ptr('pointerdown', 110, 220); map.fire('movestart'); await sleep(50); ptr('pointerup', 110, 220);
  check(fired.length === 1, 'a map move under the finger cancels the press');
  // a press on a marker, not the canvas → not the map's
  ptr('pointerdown', 110, 220, { target: { marker: true } }); await sleep(50); ptr('pointerup', 110, 220);
  check(fired.length === 1, 'a press that begins on a marker is the marker\'s, not a pin under it');
  // iOS: WebKit runs no timers while the finger is down — a finger released after the hold still fires, at release
  clock += 1000;
  ptr('pointerdown', 120, 240); clock += 30 + 1; ptr('pointerup', 120, 240);
  check(fired.length === 2 && Math.abs(fired[1].lng - 1.1) < 1e-9, 'a finger released after the hold (with the timer never run) fires at release — the iOS path');
  // iOS defers DISPATCH by a varying amount but the events keep their hardware timeStamps:
  // a 900 ms hold whose events arrive 300 ms apart is still a press, and a tap whose events arrive late is still a tap
  clock += 1000;
  ptr('pointerdown', 130, 240, { ts: clock - 1430 }); clock += 300; ptr('pointerup', 130, 240, { ts: clock - 821 - 300 + 946 });
  check(fired.length === 3 && Math.abs(fired[2].lng - 1.2) < 1e-9, 'the hold is measured on the events\' own timeStamps, not on when WebKit dispatched them (900 ms apart, delivered 300 ms apart → a press)');
  clock += 1000;
  ptr('pointerdown', 130, 240, { ts: clock - 1430 }); clock += 700; ptr('pointerup', 130, 240, { ts: clock - 1430 - 700 + 20 });
  check(fired.length === 3, 'a 20 ms tap whose events were dispatched 700 ms apart is still a tap (the hold here is 30 ms)');
  await sleep(50);
  check(fired.length === 3, 'and the timer does not fire it a second time');
  clock += 1000;
  ptr('pointerdown', 120, 240); clock += 30 + 1; ptr('pointercancel', 120, 240); await sleep(50);
  check(fired.length === 3, 'a cancelled pointer (the system took the gesture) never drops, however long it was down');
  // a mouse button held is not a touch press (its right button is the door)
  ptr('pointerdown', 110, 220, { pointerType: 'mouse' }); await sleep(50); ptr('pointerup', 110, 220, { pointerType: 'mouse' });
  check(fired.length === 3, 'a held mouse button drops nothing');
  // right-click / Android contextmenu: fires with mapbox's own lngLat, deduped against the timer
  clock += 1000;
  map.fire('contextmenu', { lngLat: { lng: -108, lat: 44 }, preventDefault: () => {} });
  check(fired.length === 4 && fired[3].lng === -108, 'a right-click (mapbox contextmenu) drops at its lngLat');
  clock += 100;
  map.fire('contextmenu', { lngLat: { lng: -108, lat: 44 }, preventDefault: () => {} });
  check(fired.length === 4, 'a second contextmenu inside the dedupe window (Android fires both) is the same press');
  lp.detach();
  clock += 1000;
  ptr('pointerdown', 110, 220); await sleep(50); ptr('pointerup', 110, 220);
  map.fire('contextmenu', { lngLat: { lng: 1, lat: 1 }, preventDefault: () => {} });
  check(fired.length === 4, 'detached: nothing fires');
  check(HOLD_MS >= 400 && HOLD_MS <= 700, `the hold is a real long press (${HOLD_MS} ms), not a slow tap`);
}

// ---------------------------------------------------------------- pure: the labels
{
  const g = labelFromGeocode({ results: [
    { types: ['plus_code'], formatted_address: '2X7Q+8F Lovell, WY', address_components: [] },
    { types: ['route'], formatted_address: 'US-14A, Lovell, WY 82431, USA', address_components: [{ long_name: 'US-14A', types: ['route'] }, { long_name: 'Lovell', types: ['locality', 'political'] }] },
  ] });
  check(g?.name === 'US-14A, Lovell' && g.road === 'US-14A' && g.source === 'geocode', `a road result names the pin by road and town (${g?.name})`);
  const g2 = labelFromGeocode({ results: [{ types: ['locality', 'political'], formatted_address: 'Lovell, WY 82431, USA', address_components: [{ long_name: 'Lovell', types: ['locality'] }] }] });
  check(g2?.name === 'Lovell', 'no road: the town');
  check(labelFromGeocode({ results: [{ types: ['plus_code'], formatted_address: '2X7Q+8F', address_components: [] }] }) === null && labelFromGeocode({}) === null, 'a plus code alone is not a name; no results, no name');
  const n = labelFromNearby({ places: [{ displayName: { text: 'Bighorn Canyon Overlook' }, formattedAddress: 'Lovell, WY' }] }, { near: 'Cerca de' });
  check(n?.name === 'Cerca de Bighorn Canyon Overlook' && n.source === 'nearby', `nearby fallback says "Near X" in the rider's language (${n?.name})`);
  check(labelFromNearby({ places: [] }) === null, 'nothing nearby, no name');
}

// ---------------------------------------------------------------- the browser
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const enc6 = (pts) => {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => { let s = ''; v = v < 0 ? ~(v << 1) : (v << 1); while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lng, lat] of pts) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); out += enc(a - plat) + enc(b - plng); plat = a; plng = b; }
  return out;
};
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
const ME = { lat: 44.02, lng: -108.01 };
const GEO = { name: 'US-14A, Lovell', detail: 'US-14A, Lovell, WY 82431, USA', road: 'US-14A', locality: 'Lovell', source: 'geocode' };

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

// a held finger on the canvas: pointerdown, hold, pointerup — the events iOS
// delivers on time (Playwright's touchscreen only taps; the iOS simulator is the real-finger check)
const holdOn = (page, mapExpr, x, y, ms) => page.evaluate(async ({ mapExpr, x, y, ms }) => {
  const map = eval(mapExpr); // eslint-disable-line no-eval
  const c = map.getCanvas();
  const mk = (type) => new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
  c.dispatchEvent(mk('pointerdown'));
  await new Promise((r) => setTimeout(r, ms));
  c.dispatchEvent(mk('pointerup'));
}, { mapExpr, x, y, ms });
const canvasPoint = (page, mapExpr, fx, fy) => page.evaluate(({ mapExpr, fx, fy }) => { const r = eval(mapExpr).getCanvas().getBoundingClientRect(); return { x: r.left + r.width * fx, y: r.top + r.height * fy }; }, { mapExpr, fx, fy }); // eslint-disable-line no-eval
// a spot on OPEN map: nothing of ours under it (no route line, no marker, no pin, no overlay) — scanned from a start fraction
const emptyPoint = (page, mapExpr, fx, fy) => page.evaluate(({ mapExpr, fx, fy }) => {
  const map = eval(mapExpr); // eslint-disable-line no-eval
  const c = map.getCanvas(); const r = c.getBoundingClientRect();
  const ours = map.getStyle().layers.map((l) => l.id).filter((id) => /^(route-|leg-hi|picker|route-drag)/.test(id) && map.getLayer(id));
  for (let dy = 0; dy < 0.5; dy += 0.05) for (let dx = 0; dx < 0.5; dx += 0.05) {
    const x = r.left + r.width * (fx + dx), y = r.top + r.height * (fy - dy);
    if (x > r.right - 20 || y < r.top + 20) continue;
    if (document.elementFromPoint(x, y) !== c) continue;
    if (map.queryRenderedFeatures([x - r.left, y - r.top], { layers: ours }).length) continue;
    return { x, y };
  }
  return null;
}, { mapExpr, fx, fy });

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
  const hits = { geocode: 0, nearby: 0 };
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/reverse-geocode')) { hits.geocode++; return r.fulfill({ json: GEO }); }
    if (u.includes('/.netlify/functions/nearby-places')) { hits.nearby++; return r.fulfill({ json: [] }); }
    if (u.includes('/.netlify/functions/place-details')) return r.fulfill({ status: 404, json: {} });
    if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    if (u.includes(`localhost:${PORT}`)) return r.continue();
    return r.abort();
  });
  await page.addInitScript((me) => {
    const stub = { getCurrentPosition: (ok) => ok({ coords: { latitude: me.lat, longitude: me.lng, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }), watchPosition: (ok) => { window.__geoCb = ok; return 1; }, clearWatch: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
    window.__promptCalled = false; window.prompt = () => { window.__promptCalled = true; return null; };
  }, ME);
  await seedRideAck(page); // Ride Mode's safety gate is answered once per device
  await page.goto(`${BASE}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 15000 });
  await page.evaluate(() => {
    const mk = (id, name, lat, lng, extra = {}) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '', ...extra });
    window.__dispatch({
      type: 'create_trip', name: 'GRANITE',
      trip: {
        meta: { title: 'GRANITE', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
        days: [{
          id: 'q1', dow: 'Wed', date: '2026-08-12', title: 'Granite day', phase: 'outbound',
          miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
          lodging: { status: 'none', name: '', where: '', note: '' },
          waypoints: [mk('qa', 'Basecamp', 44.0, -108.0, { kind: 'start' }), mk('qb', 'Granite Diner', 44.06, -107.95, { dwell: 30 }), mk('qc', 'End Lodge', 44.10, -107.88, { kind: 'end' })],
        }],
      },
    });
  });
  await page.waitForTimeout(600);
  if (await page.locator('.mast-back').isVisible().catch(() => false)) { await page.locator('.mast-back').click(); await page.waitForSelector('.home-map', { timeout: 8000 }); }
  await page.waitForFunction(() => window.__homeMap?.isStyleLoaded?.(), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const lib = () => page.evaluate(() => { const l = JSON.parse(localStorage.getItem('moto.trips.v1')); return { active: l.activeId, trip: l.trips.find((r) => r.id === l.activeId).trip, all: l.trips }; });

  // ---------------- HOME MAP
  const pinState = () => page.evaluate(() => {
    const pin = document.querySelector('.drop-pin');
    if (!pin) return { pin: false };
    const tip = pin.querySelector('.dp-tip').getBoundingClientRect();
    const needle = pin.querySelector('.dp-needle').getBoundingClientRect();
    const acts = [...pin.querySelectorAll('.dp-act')].map((b) => { const r = b.getBoundingClientRect(); return { cls: b.className.replace('dp-act ', ''), w: r.width, h: r.height, on: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; });
    return { pin: true, tip: { x: tip.left + tip.width / 2, y: tip.top + tip.height / 2 }, needleBottom: needle.bottom, needleTop: needle.top, acts, hint: (document.querySelector('.hm-drop-hint') ?? document.querySelector('.map-hint'))?.innerText ?? '', card: !!document.querySelector('.hm-place'), sheet: !!document.querySelector('.place-sheet') };
  });
  // 1. a plain tap drops nothing — it steps the sheet down
  const before = await page.evaluate(() => document.querySelector('.hm-sheet').dataset.state);
  const p1 = await canvasPoint(page, 'window.__homeMap', 0.5, 0.3);
  if (phone) await page.touchscreen.tap(p1.x, p1.y); else await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(500);
  const afterTap = await page.evaluate(() => ({ state: document.querySelector('.hm-sheet').dataset.state, card: !!document.querySelector('.hm-place'), pins: document.querySelectorAll('.drop-pin').length }));
  check(!afterTap.card && afterTap.pins === 0 && (before === 'min' || afterTap.state !== before || !phone), `a plain tap drops no pin (sheet ${before} → ${afterTap.state})`);

  // 2. a long press (phone: a real held touch; desktop: a right-click) drops the NEEDLE with the wheel — no card yet
  hits.geocode = 0;
  const pressed = await page.evaluate(({ x, y }) => { const m = window.__homeMap; const r = m.getCanvas().getBoundingClientRect(); const ll = m.unproject([x - r.left, y - r.top]); return { lng: ll.lng, lat: ll.lat }; }, p1);
  if (phone) await holdOn(page, 'window.__homeMap', p1.x, p1.y, HOLD_MS + 200);
  else await page.mouse.click(p1.x, p1.y, { button: 'right' });
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.waitForFunction(() => /US-14A, Lovell/.test(document.querySelector('.hm-drop-hint')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(800); // the focus ease settles
  const s2 = await pinState();
  const tipAt = await page.evaluate((pt) => { const m = window.__homeMap; const r = m.getCanvas().getBoundingClientRect(); const p = m.project([pt.lng, pt.lat]); return { x: r.left + p.x, y: r.top + p.y }; }, pressed);
  check(s2.pin && !s2.card, 'a press drops the pin and opens NO card — adjust and confirm are separate acts');
  check(Math.hypot(s2.tip.x - tipAt.x, s2.tip.y - tipAt.y) < 2 && Math.abs(s2.needleBottom - tipAt.y) < 3, `the needle's tip sits on the pressed coordinate to the pixel (${Math.hypot(s2.tip.x - tipAt.x, s2.tip.y - tipAt.y).toFixed(1)}px)`);
  check(s2.needleTop < s2.tip.y - 40, `the head rises ${Math.round(s2.tip.y - s2.needleTop)}px above the tip, so a thumb never hides the spot`);
  check(s2.acts.length === 2 && s2.acts.every((a) => a.w >= 44 && a.h >= 44 && a.on), `✓ and ✕ are ≥44pt and on screen (${s2.acts.map((a) => `${a.cls} ${Math.round(a.w)}×${Math.round(a.h)}`).join(', ')})`);
  check(/US-14A, Lovell/.test(s2.hint) && /\d+\.\d{5}, -\d+\.\d{5}/.test(s2.hint) && /drag the pin/.test(s2.hint) && hits.geocode === 1, `the readout carries the road and a five-place coordinate after ONE reverse-geocode call (${s2.hint})`);
  check(hits.nearby === 0, 'no Places lookup was spent on it — there is nothing to verify');
  await page.screenshot({ path: SHOT(`pin-drop-home-${width}`) });

  // 3. drag the needle: the pin moves, the readout follows, the road is looked up again once it settles
  const dragFrom = await page.evaluate(() => { const r = document.querySelector('.drop-pin .dp-needle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.4 }; });
  await page.mouse.move(dragFrom.x, dragFrom.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(dragFrom.x + i * 8, dragFrom.y + i * 5); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(150);
  const s3a = await pinState();
  await page.waitForFunction(() => /US-14A, Lovell/.test(document.querySelector('.hm-drop-hint')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  const s3 = await pinState();
  check(Math.abs(s3.tip.x - (s2.tip.x + 64)) < 4 && Math.abs(s3.tip.y - (s2.tip.y + 40)) < 4, `dragging the needle moves the tip exactly with the finger (+${Math.round(s3.tip.x - s2.tip.x)}, +${Math.round(s3.tip.y - s2.tip.y)}px)`);
  check(!/US-14A/.test(s3a.hint) && /\d+\.\d{5}/.test(s3a.hint), 'while it settles the readout is the bare coordinate — a stale road name is never shown');
  check(/US-14A, Lovell/.test(s3.hint) && hits.geocode === 2, `the road is looked up again once, after the drag (${hits.geocode} calls)`);
  check(!s3.card, 'still no card: nothing has been confirmed');

  // 4. ✕ takes it away; a press again, then ✓ opens the card as a PLACED spot; closing the card takes the pin
  await page.locator('.drop-pin .dp-act.cancel').click();
  await page.waitForTimeout(300);
  check(await page.locator('.drop-pin').count() === 0 && await page.locator('.hm-place').count() === 0, '✕ removes the pin and opens nothing');
  await page.evaluate(() => window.__homePress({ lat: 44.03, lng: -107.99 })); // the seam: the handler a real press reaches
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.waitForFunction(() => /US-14A/.test(document.querySelector('.hm-drop-hint')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  await page.locator('.drop-pin .dp-act.confirm').click();
  await page.waitForSelector('.hm-place.placed', { timeout: 6000 });
  const s4 = await page.evaluate(() => {
    const el = document.querySelector('.hm-place');
    return { text: el.innerText, tag: el.querySelector('.tag.placed')?.textContent ?? '', btns: [...el.querySelectorAll('.hm-place-actions .btn')].map((b) => b.textContent.trim()), pin: !!document.querySelector('.drop-pin') };
  });
  check(s4.tag.includes('placed') && /A spot you placed on the map/.test(s4.text) && /US-14A, Lovell/.test(s4.text), `✓ opens the card as a PLACED spot named by its road (${s4.tag})`);
  check(s4.btns[0] === 'Ride here' && s4.btns[1] === 'Add to a trip' && !s4.btns.includes('Details') && s4.pin, `Ride here · Add to a trip — no Details for a spot with no listing; the pin stays up under the card (${s4.btns.join(' · ')})`);
  await page.screenshot({ path: SHOT(`pin-drop-home-card-${width}`) });
  await page.locator('.hm-place .mini-edit').click();
  await page.waitForTimeout(300);
  check(await page.locator('.drop-pin').count() === 0, 'closing the card takes the pin with it');

  // 5. Add to a trip → lands placed: 'rider', in route order
  await page.evaluate(() => window.__homePress({ lat: 44.03, lng: -107.99 }));
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.waitForFunction(() => /US-14A/.test(document.querySelector('.hm-drop-hint')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  await page.locator('.drop-pin .dp-act.confirm').click();
  await page.waitForSelector('.hm-place.placed', { timeout: 6000 });
  await page.locator('.hm-place-actions .btn', { hasText: 'Add to a trip' }).click();
  await page.waitForSelector('.hm-addto-row.lead', { timeout: 5000 });
  await page.locator('.hm-addto-row.lead').click();
  await page.waitForSelector('.modebar', { timeout: 8000 });
  await page.waitForTimeout(600);
  const l3 = await lib();
  const added = l3.trip.days[0].waypoints.find((w) => w.name === 'US-14A, Lovell');
  check(!!added && added.placed === 'rider' && !added.placeId && !('verified' in added), `the stop lands as placed: 'rider' with no listing claimed (${JSON.stringify({ placed: added?.placed, placeId: added?.placeId ?? null })})`);
  check(await page.locator('.wp-row .tag.placed').count() >= 1, 'and the day panel wears its ◎ placed tag');

  // ---------------- TRIP MAP (the day is selected: this is the plan map with a day open)
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  await page.waitForFunction(() => window.__map?.isStyleLoaded?.(), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  // 6. a plain tap with a day selected is the click-to-add (unchanged) — and it now stamps placed
  const p4 = await emptyPoint(page, 'window.__map', 0.3, 0.75);
  if (phone) await page.touchscreen.tap(p4.x, p4.y); else await page.mouse.click(p4.x, p4.y);
  await page.waitForTimeout(500);
  const sheetUp = await page.locator('.sheet input').count();
  check(sheetUp === 1 && !(await page.locator('.place-sheet').count()), 'a plain tap on the trip map still opens the naming sheet, never a pin');
  await page.locator('.sheet input').fill('Pullout');
  await page.locator('.sheet .btn.gold').click();
  await page.waitForTimeout(600);
  const l4 = await lib();
  const pullout = l4.trip.days[0].waypoints.find((w) => w.name === 'Pullout');
  check(pullout?.placed === 'rider', 'a tapped-and-named stop is a placed: \'rider\' pin too');
  check(await page.evaluate(() => window.__promptCalled) === false, 'window.prompt is not used');
  // 7. a long press / right-click drops the needle with the wheel; ⓘ opens the card; ✓ adds the stop
  hits.geocode = 0;
  const p5 = await emptyPoint(page, 'window.__map', 0.55, 0.8);
  if (phone) await holdOn(page, 'window.__map', p5.x, p5.y, HOLD_MS + 200);
  else await page.mouse.click(p5.x, p5.y, { button: 'right' });
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.waitForFunction(() => /US-14A, Lovell/.test(document.querySelector('.map-hint')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  const s7 = await pinState();
  check(s7.pin && !s7.sheet && s7.acts.length === 3 && s7.acts.every((a) => a.w >= 44 && a.h >= 44), 'the trip map drops the same needle with ✓ / ✕ / ⓘ, and no card yet');
  check(/US-14A, Lovell/.test(s7.hint) && /✓ to add it/.test(s7.hint) && hits.geocode === 1, `the map's hint region carries the readout (${s7.hint})`);
  await page.locator('.drop-pin .dp-act.info').click();
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  const s7b = await page.evaluate(() => { const el = document.querySelector('.place-sheet'); return { h3: el.querySelector('h3')?.textContent, tag: el.querySelector('.tag.placed')?.textContent ?? '', google: /✓ Google/.test(el.innerText), btn: el.querySelector('.ps-foot .btn.gold')?.textContent.trim(), naming: document.querySelectorAll('.sheet input').length, pin: !!document.querySelector('.drop-pin') };
  });
  check(s7b.h3 === 'US-14A, Lovell' && s7b.tag.includes('placed') && !s7b.google && /Add to this day/.test(s7b.btn ?? '') && s7b.naming === 0 && s7b.pin, `ⓘ opens the placed card named by the road, with Add to this day, the pin still up (${s7b.h3})`);
  await page.screenshot({ path: SHOT(`pin-drop-trip-${width}`) });
  await page.locator('.place-sheet .modal-head .btn').click();
  await page.waitForTimeout(300);
  check(await page.locator('.drop-pin').count() === 1 && await page.locator('.place-sheet').count() === 0, 'closing the card keeps the pin — nothing was decided yet');
  await page.locator('.drop-pin .dp-act.confirm').click();
  await page.waitForTimeout(600);
  const l5 = await lib();
  const dropped = l5.trip.days[0].waypoints.filter((w) => w.name === 'US-14A, Lovell');
  check(dropped.length === 2 && dropped[1].placed === 'rider' && !dropped[1].placeId, '✓ adds it to the day as a placed: \'rider\' stop');
  check(await page.locator('.drop-pin').count() === 0, 'and the pin is gone once it is a stop');
  // 8. a tap on open map dismisses a dropped pin rather than adding
  if (phone) await holdOn(page, 'window.__map', p5.x, p5.y, HOLD_MS + 200); else await page.mouse.click(p5.x, p5.y, { button: 'right' });
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.waitForTimeout(800); // past the press's own click-swallow window (SWALLOW_MS)
  const p8 = await emptyPoint(page, 'window.__map', 0.2, 0.55);
  if (phone) await page.touchscreen.tap(p8.x, p8.y); else await page.mouse.click(p8.x, p8.y);
  await page.waitForTimeout(400);
  const s8 = await page.evaluate(() => ({ pin: document.querySelectorAll('.drop-pin').length, naming: document.querySelectorAll('.sheet input').length, hint: document.querySelector('.map-hint')?.innerText ?? '' }));
  check(s8.pin === 0 && s8.naming === 0, `a tap on open map takes the pin away and never opens the naming sheet (${JSON.stringify(s8)})`);

  // ---------------- HOME again: Ride here from a dropped pin is a real quick ride to a PLACED destination
  await page.locator('.mast-back').click();
  await page.waitForSelector('.home-map', { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__homePress({ lat: 44.03, lng: -107.99 }));
  await page.waitForSelector('.drop-pin', { state: 'attached', timeout: 6000 });
  await page.locator('.drop-pin .dp-act.confirm').click();
  await page.waitForSelector('.hm-place.placed', { timeout: 6000 });
  await page.locator('.hm-place-actions .btn', { hasText: 'Ride here' }).click();
  await page.waitForSelector('.hm-ride-confirm .btn.gold', { timeout: 5000 });
  await page.locator('.hm-ride-confirm .btn.gold').click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  const l7 = await lib();
  const dest = l7.trip.days[0].waypoints[1];
  check(l7.trip.meta.quick === true && dest.placed === 'rider' && !dest.placeId && Math.abs(dest.lat - 44.03) < 1e-6, `Ride here from a dropped pin makes a quick ride whose destination is the placed coordinate (${dest.name})`);
  check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

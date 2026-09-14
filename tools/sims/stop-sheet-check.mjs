// Tapping a stop marker on the plan map opens THAT STOP's card (owner,
// Sep 13 2026: "PlaceSheet with the stop's facts: ETA from the timeline, the
// leg miles, its verified/placed tag — instead of only a hover tooltip").
// A verified stop fetches its Google details by placeId (photo, rating,
// hours) the way a tapped POI does; a placed pin gets the plain sheet with
// its ◎; an unverified one says so. Edit is one tap on (the stop editor);
// drag-to-move is untouched and a moved marker becomes a placed: 'rider'
// pin. Mapbox, Places, Valhalla mocked; 375 (touch + mobile) and 1280.
//
//   npm run dev    # :5199 (RB_PORT overrides)
//   node tools/sims/stop-sheet-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';

const PORT = process.env.RB_PORT ?? '5199';
const BASE = `http://localhost:${PORT}`;
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const HOURS = ['Monday: 7:00 AM – 8:00 PM', 'Tuesday: 7:00 AM – 8:00 PM', 'Wednesday: 7:00 AM – 8:00 PM', 'Thursday: 7:00 AM – 8:00 PM', 'Friday: 7:00 AM – 9:00 PM', 'Saturday: 8:00 AM – 9:00 PM', 'Sunday: Closed'];
const DETAILS = { id: 'g-diner', name: 'Granite Diner', detail: '12 Main St, Granite, WY', lat: 44.06, lng: -107.95, rating: 4.6, userRatingCount: 212, priceLevel: 'PRICE_LEVEL_MODERATE', openNow: true, hours: HOURS, phone: '(307) 555-0100', websiteUri: 'https://granitediner.example/', summary: 'Pie and coffee on the pass road.', photos: [{ name: 'places/g-diner/photos/p1', by: [{ name: 'Granite Diner', uri: 'https://maps.google.com/maps/contrib/1' }] }], reviews: [], amenities: [] };

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

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function run(width, label) {
  console.log(`\n── ${label} (${width}px) ──`);
  const phone = width < 820;
  const ctx = await browser.newContext({ viewport: { width, height: 820 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
  const hits = { details: 0, photo: 0, nearby: 0 };
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/nearby-places')) { hits.nearby++; return r.fulfill({ json: [] }); }
    if (u.includes('/.netlify/functions/place-details')) { hits.details++; return r.fulfill({ json: DETAILS }); }
    if (u.includes('/.netlify/functions/place-photo')) { hits.photo++; return r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }); }
    if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    if (u.includes(`localhost:${PORT}`)) return r.continue();
    return r.abort();
  });
  await page.goto(`${BASE}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 15000 });
  await page.evaluate(() => {
    const mk = (id, name, lat, lng, extra = {}) => ({ id, kind: 'via', name, lat, lng, mile: null, note: '', ...extra });
    window.__dispatch({
      type: 'create_trip', name: 'STOPS',
      trip: {
        meta: { title: 'STOPS', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
        days: [{
          id: 'q1', dow: 'Wed', date: '2026-08-12', title: 'Stop day', phase: 'outbound',
          miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
          lodging: { status: 'none', name: '', where: '', note: '' },
          waypoints: [
            mk('qa', 'Basecamp', 44.0, -108.0, { kind: 'start', placed: 'author' }),
            mk('qb', 'Granite Diner', 44.06, -107.95, { dwell: 30, placeId: 'g-diner', verified: 'google', note: 'Pie stop' }),
            mk('qc', 'Ghost Station', 44.08, -107.92, { fuel: true, verified: false }),
            mk('qd', 'End Lodge', 44.10, -107.88, { kind: 'end' }),
          ],
        }],
      },
    });
  });
  await page.waitForTimeout(400);
  // create_trip fills the library; the rider opens it from the sheet
  if (!(await page.locator('.modebar').isVisible().catch(() => false))) {
    // on a desktop the trips live in the Your trips drawer (PR #100)
    const tb = page.locator('.hm-tripsbtn'); if (await tb.isVisible().catch(() => false)) { await tb.click(); await page.waitForTimeout(300); }
    await page.locator('.trip-card.active').first().click();
  }
  await page.waitForSelector('.modebar', { timeout: 15000 });
  await page.waitForTimeout(800);
  const lib = () => page.evaluate(() => { const l = JSON.parse(localStorage.getItem('moto.trips.v1')); return l.trips.find((r) => r.id === l.activeId).trip; });
  // select the day, get the panel off the map on a phone
  await page.locator('.ribbon .rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.wp-row', { timeout: 8000 });
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  await page.waitForFunction(() => window.__map?.isStyleLoaded?.() && document.querySelectorAll('.wp-marker').length >= 4, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const markers = await page.evaluate(() => [...document.querySelectorAll('.wp-marker')].map((m) => ({ name: m.querySelector('.wp-label')?.textContent, r: m.getBoundingClientRect() })));
  check(markers.length === 4, `the day's four stops are markers (${markers.length})`);
  const tapMarker = async (name) => {
    const m = markers.find((x) => x.name === name);
    const x = m.r.left + m.r.width / 2, y = m.r.top + m.r.height / 2;
    if (phone) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
  };

  // 1. a VERIFIED stop: the card with the timeline's facts + Google's details
  hits.details = 0; hits.photo = 0;
  // count every hover tooltip that is ever ATTACHED — a finger has no hover,
  // and the tap used to flash the desktop tooltip for a frame before the card
  await page.evaluate(() => { window.__tips = 0; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('mapboxgl-popup')) window.__tips++; }).observe(document.body, { childList: true, subtree: true }); });
  await tapMarker('Granite Diner');
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  if (phone) check(await page.evaluate(() => window.__tips) === 0, 'a touch tap never flashes the hover tooltip on its way to the card');
  await page.waitForFunction(() => /★ 4\.6/.test(document.querySelector('.place-sheet')?.innerText ?? ''), null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(300);
  const s1 = await page.evaluate(() => {
    const el = document.querySelector('.place-sheet');
    const cells = [...el.querySelectorAll('.ss-strip .ts-cell')].map((c) => `${c.querySelector('.l').textContent}=${c.querySelector('.n').textContent}`);
    return { h3: el.querySelector('h3')?.textContent, kicker: el.querySelector('.ps-kicker')?.textContent, text: el.innerText, cells, tag: el.querySelector('.ss-tags .tag')?.className ?? '', img: !!el.querySelector('.ps-hero img'), btns: [...el.querySelectorAll('.ps-foot .btn')].map((b) => b.textContent.trim()), naming: document.querySelectorAll('.sheet input').length, editor: document.querySelectorAll('.modal .fld input').length };
  });
  check(s1.h3 === 'Granite Diner' && /^Day 1 · Wed/.test(s1.kicker) && /stop 2 of 4/.test(s1.kicker), `the marker opens the stop's card (${s1.h3} · ${s1.kicker})`);
  check(s1.cells.some((c) => /^Arrive=\d/.test(c)) && s1.cells.some((c) => /^On the ground=30/.test(c)) && s1.cells.some((c) => /^Leg in=.*mi/.test(c)), `the timeline's facts: ${s1.cells.join(' · ')}`);
  check(/verified/.test(s1.tag) && /★ 4\.6/.test(s1.text) && /Today/.test(s1.text) && s1.img && hits.details === 1 && hits.photo === 1, `a verified stop wears ✓ and fetches its details once (rating, hours, photo — ${hits.details} details / ${hits.photo} photo)`);
  check(/Pie stop/.test(s1.text), 'the stop\'s own note is on the card');
  check(s1.btns[0] === '✎ Edit stop' && s1.naming === 0 && s1.editor === 0, 'Edit stop is the action; neither the naming sheet nor the editor opened on the tap');
  await page.screenshot({ path: SHOT(`stop-sheet-${width}`) });
  // Edit hands off to the stop editor
  await page.locator('.place-sheet .ps-foot .btn.gold').click();
  await page.waitForSelector('.modal .fld input', { timeout: 5000 });
  check(await page.locator('.place-sheet').count() === 0 && (await page.locator('.modal .fld input').first().inputValue()) === 'Granite Diner', 'Edit stop opens the editor on that stop, and the card closes');
  await page.locator('.modal-foot .btn', { hasText: 'Cancel' }).click();
  await page.waitForTimeout(300);

  // 2. a PLACED stop: plain sheet, ◎ placed, no details call
  hits.details = 0;
  await tapMarker('Basecamp');
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  await page.waitForTimeout(300);
  const s2 = await page.evaluate(() => { const el = document.querySelector('.place-sheet'); return { h3: el.querySelector('h3')?.textContent, tag: el.querySelector('.ss-tags .tag')?.textContent ?? '', google: /✓ Google/.test(el.innerText), coord: el.querySelector('.ss-coord')?.textContent ?? '' }; });
  check(s2.h3 === 'Basecamp' && /placed/.test(s2.tag) && !s2.google && hits.details === 0 && /44\.0000, -108\.0000/.test(s2.coord), `a placed stop: ◎ placed, its coordinate, no listing claimed, no details spent (${s2.tag})`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check(await page.locator('.place-sheet').count() === 0, 'Escape closes it');

  // 3. an UNVERIFIED fuel stop says so
  await tapMarker('Ghost Station');
  await page.waitForSelector('.place-sheet', { timeout: 6000 });
  const s3 = await page.evaluate(() => { const el = document.querySelector('.place-sheet'); return { tag: el.querySelector('.ss-tags .tag')?.textContent ?? '', note: el.querySelector('.ps-note')?.textContent ?? '', fuel: /Fuel stop/.test(el.innerText) }; });
  check(/unverified/.test(s3.tag) && /no real business/.test(s3.note) && s3.fuel, `an unverified fuel stop: ⚠ unverified + the re-pick note + its fuel tag (${s3.tag})`);
  await page.locator('.place-sheet .modal-head .btn').click();
  await page.waitForTimeout(300);

  // 4. drag-to-move is intact — and a moved marker is the rider's own pin now
  if (!phone) {
    const m = markers.find((x) => x.name === 'Granite Diner');
    const x = m.r.left + m.r.width / 2, y = m.r.top + m.r.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(x + i * 6, y + i * 6); await page.waitForTimeout(20); }
    await page.mouse.up();
    await page.waitForTimeout(700);
    const w = (await lib()).days[0].waypoints.find((s) => s.id === 'qb');
    check(Math.abs(w.lat - 44.06) > 0.0005 && w.placeId === null && !('verified' in w) && w.placed === 'rider', `dragging the marker moves the stop, drops its listing and stamps it placed: 'rider' (${w.lat.toFixed(4)}, ${w.lng.toFixed(4)})`);
    check(await page.locator('.place-sheet').count() === 0, 'a drag never opens the card');
    // hover tooltip is still there
    // (the first marker, as route-drag-check does: a marker ON the line shares its hover with the leg tooltip)
    await page.mouse.move(5, 5);
    await page.locator('.wp-marker').first().hover();
    await page.waitForTimeout(400);
    const tip = await page.evaluate(() => ({ names: document.querySelectorAll('.pp-name').length, text: document.querySelector('.mapboxgl-popup')?.innerText ?? '' }));
    check(tip.names === 1 && /stop card/.test(tip.text), `the hover tooltip still shows, and points at the card (${tip.names}: ${tip.text.replace(/\n/g, ' · ').slice(0, 80)})`);
  } else {
    // a long press on a marker is the marker's, never a pin under it
    const m = markers.find((x) => x.name === 'End Lodge');
    const x = m.r.left + m.r.width / 2, y = m.r.top + m.r.height / 2;
    await page.evaluate(async ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const mk = (type) => new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true });
      el.dispatchEvent(mk('pointerdown'));
      await new Promise((r) => setTimeout(r, 750));
      el.dispatchEvent(mk('pointerup'));
    }, { x, y });
    await page.waitForTimeout(400);
    check(await page.locator('.pl-pin[data-id="drop"]').count() === 0 && await page.locator('.place-sheet').count() === 0, 'holding a finger on a marker drops no pin under it');
  }
  check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

// The map is the home (owner, Sep 13 2026: "build out option A… ensure its
// view is optimized"). Mapbox near you with tappable POIs, the picker's
// categories as chips, a search pill that is both doors (a place name
// searches the map, a sentence opens the AI builder), and a sheet that peeks
// with the two verbs and your trips. Tap a place → its card → Ride here (a
// quick ride, straight into Ride Mode), Add to a trip (the day whose route
// passes it), Details. Mapbox, Places, Valhalla are mocked.
//
//   npm run dev    # :5199
//   node tools/sims/home-map-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { routeMapbox, isMockTile } from './fixtures/mapbox-mock.mjs';
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
// the rider sits at 44.02,-108.01; the synthetic trip runs Basecamp → Granite Diner → End Lodge
const ME = { lat: 44.02, lng: -108.01 };
const ROW = (id, name, lat, lng, extra = {}) => ({ id, name, detail: `${name} Rd, Granite WY`, lat, lng, rating: 4.4, userRatingCount: 120, priceLevel: 'PRICE_LEVEL_MODERATE', status: 'OPERATIONAL', openNow: true, primaryType: 'restaurant', types: ['restaurant'], hours: ['Monday: 7:00 AM – 8:00 PM', 'Tuesday: 7:00 AM – 8:00 PM', 'Wednesday: 7:00 AM – 8:00 PM', 'Thursday: 7:00 AM – 8:00 PM', 'Friday: 7:00 AM – 8:00 PM', 'Saturday: 7:00 AM – 8:00 PM', 'Sunday: 7:00 AM – 8:00 PM'], ...extra });
const FOOD = [ROW('g-cowboy', 'Cowboy Cafe', 44.0302, -107.9702), ROW('g-pony', 'Pony Bar', 44.025, -107.98, { primaryType: 'bar', types: ['bar'] }), ROW('g-granite', 'Granite Diner', 44.06, -107.95)];
const calls = [];
function places(body) {
  calls.push(body);
  const q = String(body.query ?? '').toLowerCase();
  if (q.includes('cowboy')) return [FOOD[0]];
  if (q.includes('granite')) return [FOOD[2]];
  if (body.category === 'food') return FOOD;
  return [];
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
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: places(r.request().postDataJSON()) });
    if (u.includes('/.netlify/functions/place-details')) return r.fulfill({ status: 404, json: {} });
    if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    if (u.includes('localhost:5199')) return r.continue();
    return r.abort();
  });
  await page.addInitScript((me) => {
    const stub = { getCurrentPosition: (ok) => ok({ coords: { latitude: me.lat, longitude: me.lng, accuracy: 5, speed: 0, heading: 0 }, timestamp: Date.now() }), watchPosition: (ok) => { window.__geoCb = ok; return 1; }, clearWatch: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
  }, ME);
  await seedRideAck(page); // Ride Mode's safety gate is answered once per device
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.home-map', { timeout: 15000 });
  // a deterministic trip beside the rider
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
  // create_trip opens the trip; the sims come back to the front door the way a rider does
  if (await page.locator('.mast-back').isVisible().catch(() => false)) { await page.locator('.mast-back').click(); await page.waitForSelector('.home-map', { timeout: 8000 }); }
  await page.waitForFunction(() => /satellite-streets/.test(window.__homeMap?.getStyle?.()?.name ?? '') && window.__homeMap.isStyleLoaded(), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const lib = () => page.evaluate(() => { const l = JSON.parse(localStorage.getItem('moto.trips.v1')); return { active: l.activeId, trip: l.trips.find((r) => r.id === l.activeId).trip, all: l.trips }; });

  // 1. the front door
  const s1 = await page.evaluate(() => {
    const m = window.__homeMap; const sh = document.querySelector('.hm-sheet').getBoundingClientRect(); const c = m.getCenter();
    const fields = [...document.querySelectorAll('input,textarea,select')].filter((e) => !['checkbox', 'radio', 'range'].includes(e.type)).map((e) => parseFloat(getComputedStyle(e).fontSize));
    return { style: m.getStyle().name, center: [c.lng, c.lat], zoom: m.getZoom(), sheet: { top: sh.top, h: sh.height, w: sh.width, left: sh.left }, pill: document.querySelector('.hm-pill')?.textContent, chips: document.querySelectorAll('.hm-chip').length, chipText: [...document.querySelectorAll('.hm-chip')].map((e) => e.textContent).join('|'), cards: document.querySelectorAll('.hm-trips-row .trip-card').length, verbs: [...document.querySelectorAll('.hm-verbs .btn')].length, near: document.querySelector('.hm-near')?.textContent, under16: fields.filter((v) => v < 16).length, wider: document.documentElement.scrollWidth > innerWidth, logo: !!document.querySelector('.hm-map .mapboxgl-ctrl-logo') };
  });
  check(/satellite-streets/.test(s1.style), `the home map is Mapbox satellite-streets (${s1.style})`);
  check(Math.abs(s1.center[1] - ME.lat) < 0.01 && Math.abs(s1.center[0] - ME.lng) < 0.01 && s1.zoom >= 12, `the camera landed on the rider (${s1.center.map((n) => n.toFixed(3)).join(', ')} z${s1.zoom.toFixed(1)}) and says so (${s1.near})`);
  check(/Where do you want to ride\?/.test(s1.pill) && s1.chips === 6 && !s1.chipText.includes('Coffee'), 'the pill keeps the old hero\'s words; six category chips, no Coffee on the map');
  check(s1.verbs === 0, 'no verb buttons: the pill is the one door');
  check(s1.cards >= 1, 'your trips ride in the sheet');
  if (phone) check(s1.sheet.h > 300 && s1.sheet.h < 380 && s1.sheet.top > 400, `on a phone the sheet PEEKS (${Math.round(s1.sheet.h)}px of 820) and the map owns the rest`);
  else {
    const nav = await page.evaluate(() => { const top = document.querySelector('.hm-top').getBoundingClientRect(); const sh = document.querySelector('.hm-sheet'); const cs = getComputedStyle(sh); return { navW: top.width, navH: top.height, brand: !!document.querySelector('.hm-brand .roadbook-lockup'), trips: document.querySelector('.hm-tripsbtn')?.textContent ?? '', sheetOpen: sh.classList.contains('open'), sheetOpacity: cs.opacity, sheetEvents: cs.pointerEvents }; });
    check(nav.navW >= 1200 && nav.navH < 120 && nav.brand && /Your trips/.test(nav.trips), `on a desktop the top is a NAV BAR (${Math.round(nav.navW)}×${Math.round(nav.navH)}: wordmark, pill, chips, Your trips, settings)`);
    check(!nav.sheetOpen && nav.sheetOpacity === '0' && nav.sheetEvents === 'none', 'and the library is a closed drawer — the map owns the screen');
    await page.locator('.hm-tripsbtn').click();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').classList.contains('open') && getComputedStyle(document.querySelector('.hm-sheet')).opacity === '1', null, { timeout: 3000 }).catch(() => {});
    const dr = await page.evaluate(() => { const b = document.querySelector('.hm-sheet').getBoundingClientRect(); return { open: document.querySelector('.hm-sheet').classList.contains('open'), left: b.left, w: b.width, top: b.top, cards: document.querySelectorAll('.hm-sheet .trip-card').length }; });
    check(dr.open && dr.left < 40 && dr.w < 500 && dr.top >= 80 && dr.cards >= 1, `Your trips opens the drawer under the bar with the trips (${Math.round(dr.w)}px wide, top ${Math.round(dr.top)})`);
    await page.locator('.hm-tripsbtn').click();
    await page.waitForFunction(() => !document.querySelector('.hm-sheet').classList.contains('open'), null, { timeout: 3000 }).catch(() => {});
    check(!(await page.evaluate(() => document.querySelector('.hm-sheet').classList.contains('open'))), 'and closes it again');
  }
  check((!phone || s1.under16 === 0) && !s1.wider, phone ? 'no field under 16px (no iOS focus zoom), nothing scrolls sideways' : 'nothing scrolls sideways');
  check(s1.logo, 'the Mapbox wordmark is on the map');
  // the layers pill, same as the trip map
  check(/Satellite/.test(await page.locator('.hm-layers .bs-cur').textContent()), 'the layers pill names the basemap');
  await page.locator('.hm-layers .bs-toggle').click();
  const pills = await page.locator('.hm-layers button').allTextContents();
  check(['Satellite', 'Streets', 'Dark', 'Light', '3D'].every((k) => pills.some((x) => x.trim() === k)), `Satellite · Streets · Dark · Light · 3D (${pills.map((x) => x.trim()).filter(Boolean).join(' · ')})`);
  await page.locator('.hm-layers button', { hasText: /^Streets$/ }).click();
  await page.waitForFunction(() => /streets-v12/.test(window.__homeMap?.getStyle?.()?.name ?? ''), null, { timeout: 15000 }).catch(() => {});
  check(/streets-v12/.test(await page.evaluate(() => window.__homeMap.getStyle().name)), 'picking Streets swaps the home map style');
  await page.locator('.hm-layers .bs-toggle').click();
  await page.locator('.hm-layers button', { hasText: /^Satellite$/ }).click();
  await page.waitForFunction(() => /satellite-streets/.test(window.__homeMap?.getStyle?.()?.name ?? ''), null, { timeout: 15000 }).catch(() => {});
  // the rider IS on the map: a dot at the fix, a cone once a heading arrives, and Near you re-centres
  const me1 = await page.evaluate((ME) => { const el = document.querySelector('.hm-me'); if (!el) return null; const r = el.getBoundingClientRect(); const p = window.__homeMap.project([ME.lng, ME.lat]); const mr = document.querySelector('.hm-map').getBoundingClientRect(); return { dot: !!el.querySelector('.hm-me-dot'), dx: Math.abs(r.left - mr.left - p.x), dy: Math.abs(r.top - mr.top - p.y), heading: el.classList.contains('has-heading'), nearIsButton: document.querySelector('.hm-near')?.tagName === 'BUTTON' }; }, ME);
  check(me1 && me1.dot && me1.dx < 3 && me1.dy < 3 && !me1.heading, `the rider's dot sits on their fix (${me1?.dx?.toFixed(1)}px, ${me1?.dy?.toFixed(1)}px off), no cone before a heading`);
  check(me1?.nearIsButton, 'Near you is a button');
  await page.evaluate((ME) => window.__geoCb?.({ coords: { latitude: ME.lat + 0.002, longitude: ME.lng, accuracy: 5, speed: 9, heading: 90 }, timestamp: Date.now() }), ME);
  await page.waitForTimeout(300);
  const me2 = await page.evaluate((ME) => { const el = document.querySelector('.hm-me'); const r = el.getBoundingClientRect(); const p = window.__homeMap.project([ME.lng, ME.lat + 0.002]); const mr = document.querySelector('.hm-map').getBoundingClientRect(); return { dx: Math.abs(r.left - mr.left - p.x), dy: Math.abs(r.top - mr.top - p.y), heading: el.classList.contains('has-heading'), rot: /rotateZ\(90deg\)/.test(el.style.transform), cone: getComputedStyle(el.querySelector('.hm-me-cone')).display }; }, ME);
  check(me2.dx < 3 && me2.dy < 3 && me2.heading && me2.rot && me2.cone !== 'none', `a moving fix moves the dot and turns the cone to the heading (rotateZ 90°, cone ${me2.cone})`);
  await page.evaluate(() => window.__homeMap.jumpTo({ center: [-107.5, 43.5], zoom: 8 }));
  await page.locator('.hm-near').click();
  await page.waitForFunction((ME) => { const c = window.__homeMap.getCenter(); return Math.abs(c.lat - ME.lat) < 0.03 && Math.abs(c.lng - ME.lng) < 0.03; }, ME, { timeout: 5000 }).then(() => true).catch(() => false).then((ok) => check(ok, 'tapping Near you brings the camera back to the rider'));
  await page.waitForFunction(() => !window.__homeMap.isMoving(), null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400); // moveend → onCenter, so the next search looks where the map now is
  await page.screenshot({ path: SHOT(`home-map-${width}`) });

  // 2. the sheet handle (phone) — PR #100's grammar: a TAP toggles map/content
  // (peek ↔ min), `up` is a drag away; home-sheet-check covers the rest
  if (phone) {
    const st = () => page.evaluate(() => ({ state: document.querySelector('.hm-sheet').dataset.state, h: document.querySelector('.hm-sheet').getBoundingClientRect().height }));
    const tapHandle = () => page.evaluate(() => { const h = document.querySelector('.hm-handle'); const r = h.getBoundingClientRect(); const fire = (type) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, pointerType: 'touch', isPrimary: true })); fire('pointerdown'); fire('pointerup'); });
    await page.waitForFunction(() => !window.__homeMap.isMoving(), null, { timeout: 5000 }).catch(() => {});
    await tapHandle();
    // the sheet animates its height: wait on the pixels, not the state
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'min' && document.querySelector('.hm-sheet').getBoundingClientRect().height < 80, null, { timeout: 3000 }).catch(() => {});
    const mn = await st();
    check(mn.state === 'min' && mn.h < 80, `a tap on the handle shows the map — the sheet drops to the handle alone (${Math.round(mn.h)}px)`);
    await tapHandle();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'peek', null, { timeout: 3000 }).catch(() => {});
    check((await st()).state === 'peek', 'a second tap brings the trips row back');
    // drag the handle UP: the library — templates, Start from, the trips as a grid
    await page.evaluate(() => {
      const h = document.querySelector('.hm-handle'); const r = h.getBoundingClientRect();
      const fire = (type, y) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.x + r.width / 2, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }));
      const y0 = r.y + r.height / 2; fire('pointerdown', y0); fire('pointermove', y0 - 120); fire('pointermove', y0 - 320); fire('pointerup', y0 - 380);
    });
    await page.waitForFunction(() => document.querySelector('.hm-sheet').getBoundingClientRect().height > 600, null, { timeout: 3000 }).catch(() => {});
    const up = await st();
    check(up.h > 600, `dragging the handle up opens the library (${Math.round(up.h)}px)`);
    check(await page.locator('.quick-ride').count() === 0 && await page.locator('.start-grid').count() === 1, 'pulled up, it is the library — templates, Start from — with no second ride door');
    check(await page.locator('.hm-body .trip-grid .trip-card').count() >= 1, 'pulled up, the trips are a GRID, not a row');
    // a tap on the handle from up shows the map too, and the next brings peek
    await tapHandle();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'min' && document.querySelector('.hm-sheet').getBoundingClientRect().height < 80, null, { timeout: 3000 }).catch(() => {});
    check((await st()).state === 'min', 'from the library, a tap on the handle still shows the map');
    await tapHandle();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'peek', null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    // a tap on open map steps it down
    await page.evaluate(() => window.__homePoiTap(null));
    await page.waitForTimeout(400);
    check((await page.evaluate(() => document.querySelector('.hm-sheet').dataset.state)) === 'min', 'a tap on open map steps the sheet down');
    await page.locator('.hm-handle').click();
    await page.waitForTimeout(400);
  }

  // 3. a chip: the picker in the sheet, its rows as pins
  calls.length = 0;
  await page.locator('.hm-chip', { hasText: /Food/ }).click();
  await page.waitForSelector('.hm-sheet .nb-item', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll('.pl-pin').length >= 3, null, { timeout: 5000 }).catch(() => {});
  const s3 = await page.evaluate(() => ({ rows: document.querySelectorAll('.hm-sheet .nb-item').length, pins: document.querySelectorAll('.pl-pin').length, active: document.querySelector('.hm-chip.active')?.textContent }));
  check(s3.rows === 3 && s3.pins === 3 && /Food/.test(s3.active), `Food: ${s3.rows} rows in the sheet, ${s3.pins} pins on the map`);
  check(calls.at(-1)?.category === 'food' && Math.abs(calls.at(-1)?.near?.lat - ME.lat) < 0.05, 'the search is typed and near where the map is looking');
  // the pins stay ON their places through a zoom-out — they are absolutely
  // positioned markers, not a column of relatively positioned buttons that
  // stacked 50px apart and drifted off the map on every zoom (field report)
  const drift = async () => page.evaluate(() => {
    const m = window.__homeMap; const box = m.getContainer().getBoundingClientRect();
    return [...document.querySelectorAll('.pl-pin')].map((el) => {
      const r = el.getBoundingClientRect();
      // the marker is anchored at its bottom centre
      const lng = Number(el.dataset.lng), lat = Number(el.dataset.lat);
      const p = m.project([lng, lat]);
      return Math.hypot(r.left + r.width / 2 - (box.left + p.x), r.bottom - (box.top + p.y));
    });
  });
  const d0 = await drift();
  await page.evaluate(() => window.__homeMap.zoomTo(window.__homeMap.getZoom() - 3, { duration: 0 }));
  await page.waitForTimeout(300);
  const d1 = await drift();
  check(d0.length === 3 && Math.max(...d0) < 2 && Math.max(...d1) < 2, `pins sit on their coordinates before (${d0.map((x) => x.toFixed(1))}) and after a zoom-out (${d1.map((x) => x.toFixed(1))})`);
  await page.evaluate(() => window.__homeMap.zoomTo(window.__homeMap.getZoom() + 3, { duration: 0 }));
  await page.waitForTimeout(300);
  await page.locator('.hm-sheet .nb-item', { hasText: 'Cowboy Cafe' }).locator('.nb-main').click();
  await page.waitForSelector('.hm-sheet .nb-actions .btn.gold', { timeout: 5000 });
  await page.locator('.hm-sheet .nb-actions .btn.gold').click();
  await page.waitForSelector('.hm-place', { timeout: 5000 });
  const s4 = await page.evaluate(() => ({ text: document.querySelector('.hm-place').innerText, pins: document.querySelectorAll('.pl-pin').length, btns: [...document.querySelectorAll('.hm-place-actions .btn')].map((b) => b.textContent.trim()) }));
  check(/Cowboy Cafe/.test(s4.text) && /★ 4\.4/.test(s4.text) && /Open now/.test(s4.text) && /Today 7:00 AM/.test(s4.text), 'picking a row makes it the sheet\'s card with its facts');
  check(s4.btns[0] === 'Ride here' && s4.btns[1] === 'Add to a trip' && s4.btns[2] === 'Details' && s4.pins === 1, `Ride here · Add to a trip · Details; the picker's pins give way to the card's one pin (${s4.pins})`);
  await page.screenshot({ path: SHOT(`home-map-place-${width}`) });

  // 4. Add to a trip → the day whose route passes it, in route order, verified
  await page.locator('.hm-place-actions .btn', { hasText: 'Add to a trip' }).click();
  await page.waitForSelector('.hm-addto', { timeout: 5000 });
  const s5 = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.hm-addto-row')].map((r) => r.innerText), lead: document.querySelector('.hm-addto-row.lead')?.innerText ?? '' }));
  check(/GRANITE/.test(s5.lead) && /Wed 08-12/.test(s5.lead) && /Nearest day/.test(s5.lead), `the trip whose route passes closest leads, day pre-picked (${s5.lead.split('\n')[0]})`);
  check(s5.rows.some((r) => /New trip with AI/.test(r)), 'or a new trip that includes the place');
  await page.locator('.hm-addto-row.lead').click();
  await page.waitForSelector('.modebar', { timeout: 8000 });
  await page.waitForTimeout(600);
  const l5 = await lib();
  const day = l5.trip.days[0];
  const added = day.waypoints.find((w) => w.name === 'Cowboy Cafe');
  check(l5.trip.meta.title === 'GRANITE' && !!added && added.placeId === 'g-cowboy' && added.verified === 'google', 'the stop lands in that trip as a VERIFIED stop with Google\'s identity');
  check(day.waypoints.indexOf(added) === 1, `in route order between Basecamp and Granite Diner (index ${day.waypoints.indexOf(added)})`);
  check(await page.evaluate(() => localStorage.getItem('moto.screen.v1')) === 'trip' && await page.locator('.wp-row').count() >= 4, 'and the app opens that trip on that day');

  // 5. back home: a POI tap → card → Ride here → a quick ride, straight into Ride Mode
  await page.locator('.mast-back').click();
  await page.waitForSelector('.home-map', { timeout: 8000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => window.__homePoiTap({ properties: { name: 'Cowboy Cafe', class: 'food_and_drink', maki: 'restaurant' }, geometry: { coordinates: [-107.9702, 44.0302] } }));
  await page.waitForSelector('.hm-place .nb-ver', { timeout: 8000 });
  check(/Cowboy Cafe/.test(await page.locator('.hm-place').innerText()) && /from you/.test(await page.locator('.hm-place').innerText()), 'a tapped POI resolves against Google and reads its distance from you');
  await page.locator('.hm-place-actions .btn', { hasText: 'Ride here' }).click();
  await page.waitForSelector('.hm-ride-confirm', { timeout: 5000 });
  check(await page.locator('.hm-ride-confirm .qk-roads button').count() === 3, 'Ride here opens the Roads + tolls strip on the card');
  await page.locator('.hm-ride-confirm .btn.gold').click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  const l6 = await lib();
  check(l6.trip.meta.quick === true && /Cowboy Cafe/.test(l6.trip.meta.title) && l6.trip.days[0].waypoints[1].placeId === 'g-cowboy' && l6.trip.meta.routePrefs?.style === 'touring', 'Ride here makes a REAL quick ride to the place, with the rider\'s road style');
  check(await page.evaluate(() => /satellite-streets/.test(window.__rideMap?.getStyle?.()?.name ?? '')), 'and opens Ride Mode on Mapbox');
  await page.screenshot({ path: SHOT(`home-map-ride-${width}`) });
  // leave the ride
  await page.evaluate(() => { [...document.querySelectorAll('.ride-mode button')].find((b) => b.textContent.trim() === '✕')?.click(); });
  await page.waitForTimeout(500);
  await page.locator('.mast-back').click();
  await page.waitForSelector('.home-map', { timeout: 8000 });

  // 5b. a natural feature on the home map is a placed pin — no Google
  {
    const before = calls.length;
    await page.evaluate(() => window.__homePoiTap({ properties: { name: 'Custer National Forest', class: 'park_like', maki: 'park' }, geometry: { type: 'Point', coordinates: [-107.9, 44.05] } }));
    await page.waitForSelector('.hm-place', { timeout: 8000 });
    await page.waitForTimeout(600);
    const txt = await page.locator('.hm-place').innerText();
    check(calls.length === before && /placed pin/.test(txt) && !/Checking the listing|unverified/.test(txt), 'a forest is a placed pin: no Places call, no "no listing"');
    check(!(await page.locator('.hm-place-actions .btn', { hasText: 'Ride here' }).isDisabled()) && (await page.locator('.hm-place .poi-glyph').textContent()) === '🌲', 'Ride here is live at once and it wears the park glyph');
    await page.locator('.hm-place .mini-edit').click();
    await page.waitForTimeout(300);
  }
  // "Search this area": a hand pan while the picker is open offers a re-search at the map centre
  {
    await page.locator('.hm-chip', { hasText: /Food/i }).first().click();
    await page.waitForSelector('.pl-pin', { timeout: 8000 });
    check(await page.locator('.pl-pin.pl-cat-food').count() >= 1, 'food pins wear the food colour class');
    check(await page.locator('.hm-area').count() === 0, 'no area chip before a hand pan');
    await page.evaluate(() => { const m = window.__homeMap; m.fire('dragstart'); m.jumpTo({ center: [-108.6, 44.6] }); });
    await page.waitForSelector('.hm-area', { timeout: 4000 });
    const before = calls.length;
    await page.locator('.hm-area').click();
    await page.waitForTimeout(1200);
    const last = calls[calls.length - 1];
    check(calls.length > before && Math.abs(last.near.lat - 44.6) < 0.05 && Math.abs(last.near.lng + 108.6) < 0.05, `the chip re-searches at the map centre (${last?.near?.lat?.toFixed(2)}, ${last?.near?.lng?.toFixed(2)})`);
    check(await page.locator('.hm-area').count() === 0, 'and the chip goes away with the new results');
    await page.locator('.hm-sheet .nearby button[aria-label="Cancel"], .hm-sheet button[aria-label="Cancel"]').first().click().catch(() => {});
    await page.waitForTimeout(400);
  }
  // the home map keeps Mapbox's road numbers (no route of ours here), and the
  // right-edge column reads layers → locate
  {
    const geo = await page.evaluate(() => ({
      shield: window.__homeMap?.getLayoutProperty?.('road-number-shield', 'visibility') ?? null,
      layers: document.querySelector('.hm-layers')?.getBoundingClientRect().top, locate: document.querySelector('.hm-locate')?.getBoundingClientRect().top,
      w: document.querySelector('.hm-locate')?.getBoundingClientRect().width,
    }));
    check(geo.shield !== 'none', 'the home map keeps the basemap\'s route-number shields');
    const vh = await page.evaluate(() => innerHeight);
    const sheetTop = await page.evaluate(() => document.querySelector('.hm-sheet').getBoundingClientRect().top);
    const locBottom = await page.evaluate(() => document.querySelector('.hm-locate').getBoundingClientRect().bottom);
    check(geo.w >= 44 && (phone ? (locBottom <= sheetTop + 2 && locBottom > sheetTop - 80) : locBottom > vh - 80), `the locate button sits at the bottom right, just above the sheet (bottom ${Math.round(locBottom)}, sheet top ${Math.round(sheetTop)})`);
    if (phone) {
      // at `min` with a phone's home-indicator inset the sheet is taller than
      // its 6% detent — the column follows the sheet's REAL height (owner: "the
      // locator button drops below the bottom trip tab")
      await page.addStyleTag({ content: ':root { --viewport-safe-bottom: 34px; }' });
      await page.evaluate(() => window.__homePoiTap(null));
      await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'min', null, { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      const mn = await page.evaluate(() => ({ state: document.querySelector('.hm-sheet').dataset.state, top: document.querySelector('.hm-sheet').getBoundingClientRect().top, loc: document.querySelector('.hm-locate').getBoundingClientRect().bottom, h: document.querySelector('.hm-sheet').getBoundingClientRect().height }));
      check(mn.state === 'min' && mn.h >= 88 && mn.loc <= mn.top + 2, `at min with a 34px inset the locate button still clears the sheet (button bottom ${Math.round(mn.loc)}, sheet top ${Math.round(mn.top)}, sheet ${Math.round(mn.h)}px)`);
      await page.evaluate(() => { const st = [...document.querySelectorAll('style')].find((x) => /viewport-safe-bottom: 34px/.test(x.textContent)); st?.remove(); });
      await page.locator('.hm-handle').click(); await page.waitForTimeout(400);
    }
    // frame my trips: only while no trip is in view, and it brings them back
    check(await page.locator('.hm-frame').count() === 0, 'no Frame-my-trips button while a trip is in view');
    await page.evaluate(() => window.__homeMap.jumpTo({ center: [-74, 40.7], zoom: 9 }));
    await page.waitForSelector('.hm-frame', { timeout: 4000 });
    await page.locator('.hm-frame').click();
    await page.waitForFunction(() => window.__homeMap.getBounds().getWest() < -100 && !window.__homeMap.isMoving() && !document.querySelector('.hm-frame'), null, { timeout: 6000 }).catch(() => {}); await page.waitForTimeout(300);
    const fb = await page.evaluate(() => window.__homeMap.getBounds().toArray());
    // projected, not getBounds(): the style is a globe at low zoom, where bounds are approximate
    const out = await page.evaluate(() => { const m = window.__homeMap; const { clientWidth: W, clientHeight: H } = m.getContainer(); const lib = JSON.parse(localStorage.getItem('moto.trips.v1')); return lib.trips.filter((r) => !r.trip.meta.template && !r.trip.meta.quick).flatMap((r) => r.trip.days.flatMap((d) => d.waypoints)).filter((p) => { const q = m.project([p.lng, p.lat]); return q.x < 0 || q.x > W || q.y < 0 || q.y > H; }).map((p) => p.name); });
    check(out.length === 0 && await page.locator('.hm-frame').count() === 0, `Frame my trips flies to the library — every stop on screen — and the button steps aside (${out.length ? `off: ${out.slice(0, 3).join(', ')}` : fb.map((c) => c.map((n) => n.toFixed(1)).join(',')).join(' → ')})`);
    check(await page.locator('.hm-north').count() === 0, 'no North-up button while the map is north-up');
    await page.evaluate(() => { window.__homeMap.setBearing(40); window.__homeMap.fire('rotateend'); });
    await page.waitForSelector('.hm-north', { timeout: 3000 });
    check(true, 'a turned map offers North up');
    await page.locator('.hm-north').click();
    await page.waitForTimeout(600);
    check(Math.abs(await page.evaluate(() => window.__homeMap.getBearing())) < 1 && await page.locator('.hm-north').count() === 0, 'North up straightens the map and goes away');
  }

  // 6. the pill: a place searches the map; a sentence is a plan
  await page.locator('.hm-pill').click();
  await page.waitForSelector('.hm-input', { timeout: 5000 });
  check((await page.evaluate(() => getComputedStyle(document.querySelector('.hm-input')).fontSize)) === '16px', 'the search field is 16px — no zoom on focus');
  check(/Plan a trip with AI/.test(await page.locator('.hm-ai.lead').innerText()), 'an empty pill offers the planner as one standing row');
  await page.fill('.hm-input', 'Granite Diner');
  await page.waitForSelector('.hm-results button', { timeout: 8000 });
  const s7 = await page.evaluate(() => ({ ai: document.querySelector('.hm-ai')?.innerText ?? '', lead: !!document.querySelector('.hm-ai.lead'), first: document.querySelector('.hm-results b')?.textContent }));
  check(s7.first === 'Granite Diner' && /Plan a trip to Granite Diner with AI/.test(s7.ai) && !s7.lead, 'a place name lists places first, with the AI row as the second door');
  await page.locator('.hm-results button').first().click();
  await page.waitForSelector('.hm-place', { timeout: 5000 });
  await page.waitForTimeout(900);
  const s8 = await page.evaluate(() => { const c = window.__homeMap.getCenter(); return { name: document.querySelector('.hm-place b')?.textContent, center: [c.lng, c.lat], search: !!document.querySelector('.hm-search') }; });
  check(s8.name === 'Granite Diner' && !s8.search && Math.abs(s8.center[1] - 44.06) < 0.02 && Math.abs(s8.center[0] + 107.95) < 0.02, 'Show closes the search, opens the card and flies the map there');
  // the card's place is a pin on the map (owner: "when I look up a location it doesn't drop a pin")
  await page.waitForFunction(() => document.querySelectorAll('.pl-pin').length === 1, null, { timeout: 3000 }).catch(() => {});
  const s8p = await page.evaluate(() => { const el = document.querySelector('.pl-pin'); return el ? { n: document.querySelectorAll('.pl-pin').length, name: el.querySelector('.pl-label')?.textContent, hot: el.classList.contains('hot'), lat: Number(el.dataset.lat) } : null; });
  check(s8p && s8p.n === 1 && s8p.name === 'Granite Diner' && s8p.hot && Math.abs(s8p.lat - 44.06) < 0.02, `a searched place is a hot pin at its spot (${JSON.stringify(s8p)})`);
  // the home chrome reads on imagery in the LIGHT theme too (owner: "the contrast is way off")
  const contrast = await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    const lum = (c) => { const m = c.match(/\d+/g) || [0, 0, 0]; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    const r = {}; for (const [k, q] of [['pill', '.hm-pill'], ['chip', '.hm-chip'], ['near', '.hm-near'], ['locate', '.hm-locate']]) { const el = document.querySelector(q); if (el) r[k] = +lum(getComputedStyle(el).color).toFixed(2); }
    document.documentElement.removeAttribute('data-theme');
    return r;
  });
  check(Object.values(contrast).length >= 3 && Object.values(contrast).every((l) => l > 0.6), `light theme: the pill, chips and buttons keep light ink on the dark glass (${JSON.stringify(contrast)})`);
  await page.locator('.hm-place .mini-edit').click();
  await page.locator('.hm-pill').click();
  await page.fill('.hm-input', '4 riders, 3 days, Granite loop, back roads');
  await page.waitForTimeout(600);
  check(await page.locator('.hm-ai.lead').count() === 1 && /Plan this ride with AI/.test(await page.locator('.hm-ai').innerText()) && await page.locator('.hm-results').count() === 0, 'a sentence is a plan: the AI row leads and no places are searched');
  await page.locator('.hm-ai').click();
  await page.waitForSelector('.construction-composer textarea', { timeout: 8000 });
  check((await page.locator('.construction-composer textarea').inputValue()) === '4 riders, 3 days, Granite loop, back roads', 'the builder opens with the sentence');
  await page.screenshot({ path: SHOT(`home-map-ai-${width}`) });
  check(pageErrors.length === 0, `no page errors (${pageErrors.length})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

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
    return { style: m.getStyle().name, center: [c.lng, c.lat], zoom: m.getZoom(), sheet: { top: sh.top, h: sh.height, w: sh.width, left: sh.left }, pill: document.querySelector('.hm-pill')?.textContent, chips: document.querySelectorAll('.hm-chip').length, cards: document.querySelectorAll('.hm-trips-row .trip-card').length, verbs: [...document.querySelectorAll('.hm-verbs .btn')].length, near: document.querySelector('.hm-near')?.textContent, under16: fields.filter((v) => v < 16).length, wider: document.documentElement.scrollWidth > innerWidth, logo: !!document.querySelector('.hm-map .mapboxgl-ctrl-logo') };
  });
  check(/satellite-streets/.test(s1.style), `the home map is Mapbox satellite-streets (${s1.style})`);
  check(Math.abs(s1.center[1] - ME.lat) < 0.01 && Math.abs(s1.center[0] - ME.lng) < 0.01 && s1.zoom >= 12, `the camera landed on the rider (${s1.center.map((n) => n.toFixed(3)).join(', ')} z${s1.zoom.toFixed(1)}) and says so (${s1.near})`);
  check(/Where do you want to ride\?/.test(s1.pill) && s1.chips === 7, 'the pill keeps the old hero\'s words; seven category chips');
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
  await page.screenshot({ path: SHOT(`home-map-${width}`) });

  // 2. the sheet handle (phone)
  if (phone) {
    await page.locator('.hm-handle').click();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').getBoundingClientRect().height > 600, null, { timeout: 3000 }).catch(() => {});
    const up = await page.evaluate(() => document.querySelector('.hm-sheet').getBoundingClientRect().height);
    check(up > 600, `the handle pulls the sheet up (${Math.round(up)}px)`);
    check(await page.locator('.quick-ride').count() === 0 && await page.locator('.start-grid').count() === 1, 'pulled up, it is the library — templates, Start from — with no second ride button');
    check(await page.locator('.hm-body .trip-grid .trip-card').count() >= 1, 'pulled up, the trips are a GRID, not a row');
    await page.locator('.hm-handle').click();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'peek' && Math.abs(document.querySelector('.hm-sheet').getBoundingClientRect().height - innerHeight * 0.42) < 4, null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    // drag the handle DOWN: the sheet snaps to its minimum — the two verbs and the map
    // (a pointer sequence on the handle: Playwright's mouse drag does not reach a
    // touch-action:none button under phone emulation; the iOS simulator is the
    // real-finger check)
    await page.evaluate(() => {
      const h = document.querySelector('.hm-handle'); const r = h.getBoundingClientRect();
      const fire = (type, y) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.x + r.width / 2, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }));
      const y0 = r.y + r.height / 2; fire('pointerdown', y0); fire('pointermove', y0 + 80); fire('pointermove', y0 + 200); fire('pointerup', y0 + 260);
    });
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'min' && document.querySelector('.hm-sheet').getBoundingClientRect().height < 80, null, { timeout: 3000 }).catch(() => {});
    const mn = await page.evaluate(() => ({ state: document.querySelector('.hm-sheet').dataset.state, h: document.querySelector('.hm-sheet').getBoundingClientRect().height, verbs: 0 }));
    check(mn.state === 'min' && mn.h < 80, `dragging the handle down dismisses the sheet to the handle alone (${Math.round(mn.h)}px)`);
    await page.locator('.hm-handle').click();
    await page.waitForFunction(() => document.querySelector('.hm-sheet').dataset.state === 'peek', null, { timeout: 3000 }).catch(() => {});
    check((await page.evaluate(() => document.querySelector('.hm-sheet').dataset.state)) === 'peek', 'a tap on the handle brings it back to peek');
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
  await page.locator('.hm-sheet .nb-item', { hasText: 'Cowboy Cafe' }).locator('.nb-main').click();
  await page.waitForSelector('.hm-sheet .nb-actions .btn.gold', { timeout: 5000 });
  await page.locator('.hm-sheet .nb-actions .btn.gold').click();
  await page.waitForSelector('.hm-place', { timeout: 5000 });
  const s4 = await page.evaluate(() => ({ text: document.querySelector('.hm-place').innerText, pins: document.querySelectorAll('.pl-pin').length, btns: [...document.querySelectorAll('.hm-place-actions .btn')].map((b) => b.textContent.trim()) }));
  check(/Cowboy Cafe/.test(s4.text) && /★ 4\.4/.test(s4.text) && /Open now/.test(s4.text) && /Today 7:00 AM/.test(s4.text), 'picking a row makes it the sheet\'s card with its facts');
  check(s4.btns[0] === 'Ride here' && s4.btns[1] === 'Add to a trip' && s4.btns[2] === 'Details' && s4.pins === 0, 'Ride here · Add to a trip · Details; the pins are gone');
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

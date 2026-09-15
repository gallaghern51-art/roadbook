// Layered satellite: Mapbox's imagery UNDERNEATH, Mapbox's vector roads /
// labels / POIs on top — so a POI on the satellite view is a real feature a
// rider can tap, resolved against Google Places for the facts, and added to
// the day. api.mapbox.com is mocked (fixtures/mapbox-mock.mjs).
//
//   · poiLayerIds() names the style's poi_label symbol layers;
//     hideNativeRoadShields() hides Mapbox's number shields and keeps exits
//   · the plan map and the nav map both run satellite-streets
//   · a tapped POI opens a card: OSM name + class glyph, then Google's match
//     (rating, open now, ✓) when one is close and plausibly the same business
//   · Add lands it in the day by ROUTE order with placeId + verified; a fuel
//     POI lands as a fuel stop; no Google match → added unverified
//   · with no day selected, Add is disabled and says why
//
//   npm run dev    # :5199
//   node tools/sims/poi-tap-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { pinGooglePlaces } from './fixtures/google-places.mjs';
import { poiLayerIds, tappableLayerIds, hideNativeRoadShields, liftSatelliteRoads } from '../../src/engine/basemaps.js';
import { poiIsNatural, poiGlyph } from '../../src/engine/nearby.js';
import { MAPBOX_MINI } from './fixtures/mapbox-mini.mjs';
import { routeMapbox, isMockTile, fakeMap } from './fixtures/mapbox-mock.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

// 0. the pure helpers over a satellite-streets-shaped style
{
  const fm = fakeMap(MAPBOX_MINI);
  check(poiLayerIds(fm).join() === 'poi-label', 'poi_label symbol layers are the tappable POIs');
  const n = hideNativeRoadShields(fm);
  check(n === 1 && fm.vis['road-number-shield'] === 'none', 'the route-number shield layer is hidden under ours');
  check(fm.vis['road-exit-shield'] === undefined && fm.vis['road-label'] === undefined && fm.vis['poi-label'] === undefined, 'exit shields, road names and POIs are left alone');
  check(hideNativeRoadShields(fm) === 0, 'idempotent: a second pass hides nothing new');
  check(poiLayerIds(fakeMap({ version: 8, sources: {}, layers: [{ id: 'satellite', type: 'raster', source: 's' }] })).length === 0, 'a raster fallback has no POI layers');
  check(tappableLayerIds(fm).join() === 'poi-label,natural-point-label', 'named natural features (natural_label, not the continent label) are tappable too');
  // natural features are placed pins, never Google lookups
  check(poiIsNatural('landform', 'mountain') && poiIsNatural('park_like', 'park') && poiIsNatural('water', '') && poiIsNatural('natural', 'peak'), 'a peak, a park, a lake and a summit are natural');
  check(!poiIsNatural('park_like', 'zoo') && !poiIsNatural('park_like', 'campsite') && !poiIsNatural('food_and_drink', 'restaurant') && !poiIsNatural('lodging', 'lodging'), 'a zoo, a campsite, a diner and a motel are listed businesses');
  check(poiGlyph('landform', 'mountain') === '⛰' && poiGlyph('park_like', 'park') === '🌲' && poiGlyph('water', 'lake') === '🌊', 'natural glyphs: peak, park, water');
  // satellite roads: a targeted lift (primary + secondary only, touring zooms, Mapbox's own colour, no casing) — the white-web repaint is gone
  const n2 = liftSatelliteRoads(fm);
  const w = fm.paint['road-primary']?.['line-width'], o = fm.paint['road-primary']?.['line-opacity'];
  check(n2 === 1 && Array.isArray(w) && w[0] === 'interpolate' && w[w.indexOf(9) + 1] === 2.4 && Array.isArray(o) && o[o.indexOf(15) + 1] === 0, `satellite: primary roads get a width floor and opacity at touring zooms, and still fade out at street zoom (${n2} layer)`);
  check(fm.paint['road-primary']?.['line-color'] === undefined && fm.paint['road-primary-case'] === undefined && fm.zoom['road-primary-case'] === undefined, 'no colour change, no casing: Mapbox\'s own look');
  check(fm.paint['road-simple'] === undefined && fm.paint['road-label'] === undefined, 'nothing else in the style is touched');
  check(liftSatelliteRoads(fakeMap({ ...MAPBOX_MINI, name: 'Mapbox Streets' })) === 0, 'Streets is left as Mapbox drew it');
}

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
const on1 = lerp(A, B, 0.3);
let calls = [];
function places(body) {
  calls.push(body);
  if (/sinclair/i.test(body.query ?? '')) return [{ id: 'g-sinclair', name: 'Sinclair Granite', detail: '12 Canyon Rd, Granite WY', lat: on1[1] + 0.0004, lng: on1[0] + 0.0003, rating: 4.3, userRatingCount: 88, priceLevel: 'PRICE_LEVEL_MODERATE', status: 'OPERATIONAL', openNow: true, primaryType: 'gas_station', types: ['gas_station'], googleMapsUri: 'https://maps.google.com/?q=x' }];
  return [];
}

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
    if (routeMapbox(r)) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: places(r.request().postDataJSON()) });
    if (u.includes('/.netlify/functions/google-route')) return r.fulfill({ status: 501, json: { error: 'no key' } });
    if (u.includes('__mock_tiles') || u.includes('__mock_relief')) return r.fulfill({ status: 204 });
    if (u.includes('localhost:5199')) return r.continue();
    if (u.includes('valhalla1.openstreetmap.de/route')) return r.fulfill({ json: valhalla(r.request().postDataJSON()) });
    if (u.includes('router.project-osrm.org')) return r.fulfill({ json: { code: 'Ok', routes: [{ distance: 1, duration: 1, legs: [{ steps: [] }] }] } });
    return r.abort();
  });
  await page.addInitScript(() => {
    const stub = { watchPosition: (cb) => { window.__geoCb = cb; return 1; }, clearWatch: () => {}, getCurrentPosition: () => {} };
    Object.defineProperty(navigator, 'geolocation', { value: stub, configurable: true });
    window.__feed = (lat, lng, heading, mps) => window.__geoCb?.({ coords: { latitude: lat, longitude: lng, accuracy: 5, speed: mps, heading }, timestamp: Date.now() });
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
      type: 'create_trip', name: 'POI TEST',
      trip: {
        meta: { title: 'POI TEST', subtitle: '', summary: '', riders: 1, startDate: '2026-08-12', fuelRule: '', range: 200, roster: [] },
        days: [{
          id: 'q1', dow: 'Wed', date: '2026-08-12', title: 'POI day', phase: 'outbound',
          miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false, summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
          lodging: { status: 'none', name: '', where: '', note: '' },
          waypoints: [mk('qa', 'Basecamp', 44.0, -108.0), mk('qb', 'Granite Diner', 44.06, -107.95, { dwell: 30 }), mk('qc', 'End Lodge', 44.10, -107.88)],
        }],
      },
    });
  });
  await page.waitForTimeout(1200);
  const lib = () => page.evaluate(() => { const l = JSON.parse(localStorage.getItem('moto.trips.v1')); return l.trips.find((r) => r.id === l.activeId).trip; });

  // 1. the plan map is on Mapbox satellite-streets
  await page.waitForFunction(() => /satellite-streets/.test(window.__map?.getStyle?.()?.name ?? ''), null, { timeout: 15000 }).catch(() => {});
  const st = await page.evaluate(() => { const s = window.__map.getStyle(); return { name: s.name, raster: s.layers.find((l) => l.type === 'raster')?.id, poi: s.layers.filter((l) => l['source-layer'] === 'poi_label').map((l) => l.id), hasPoiLayer: !!window.__map.getLayer('poi-label') }; });
  check(/satellite-streets/.test(st.name) && st.raster === 'satellite', `the plan map runs Mapbox satellite-streets (${st.name})`);
  check(st.hasPoiLayer && st.poi.join() === 'poi-label', 'its POI layer is a live symbol layer');
  check(await page.locator('.bs-cur').textContent().then((x) => /Satellite/.test(x)), 'the basemap pill still says Satellite');

  // 2. no day selected: the card opens, Add is disabled and says why
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Sinclair', class: 'fuel', subclass: 'fuel' }, geometry: { coordinates: [lng, lat] } }), on1);
  await page.waitForSelector('.place-sheet', { timeout: 5000 });
  check((await page.locator('.place-sheet .poi-glyph').textContent()) === '⛽', 'a fuel POI wears the fuel glyph');
  await page.waitForSelector('.place-sheet .nb-ver', { timeout: 6000 });
  check(/Sinclair Granite/.test(await page.locator('.place-sheet .ps-body').textContent().catch(() => '')) || /4\.3/.test(await page.locator('.place-sheet .ps-body').textContent()), 'Google\'s match is shown with its rating');
  check(await page.locator('.place-sheet .ps-foot .btn.gold').isDisabled(), 'with no day selected, Add is disabled');
  check(/Pick a day/.test(await page.locator('.place-sheet .poi-hint').textContent()), 'and the card says why');
  await page.screenshot({ path: SHOT(`poi-tap-noday-${width}`) });
  await page.locator('.place-sheet .ps-head .btn').click();

  // 3. a day selected: tap → match → Add as fuel stop, by route order, verified
  await page.locator('.ribbon .rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.wp-row', { timeout: 8000 });
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  calls = [];
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Sinclair', class: 'fuel' }, geometry: { coordinates: [lng, lat] } }), on1);
  await page.waitForSelector('.place-sheet .nb-ver', { timeout: 6000 });
  check(calls.at(-1)?.category === 'fuel' && /Sinclair/.test(calls.at(-1)?.query) && calls.at(-1)?.radiusMi <= 2, 'the Google lookup is strict-typed to the POI class and tight around the point');
  check(/Add as fuel stop/.test(await page.locator('.place-sheet .ps-foot .btn.gold').textContent()), 'the action names the role the POI implies');
  await page.screenshot({ path: SHOT(`poi-tap-${width}`) });
  await page.locator('.place-sheet .ps-foot .btn.gold').click();
  await page.waitForTimeout(600);
  let trip = await lib();
  let wps = trip.days[0].waypoints;
  const added = wps.find((w) => w.name === 'Sinclair Granite');
  check(!!added && added.fuel === true && added.kind === 'fuel' && added.placeId === 'g-sinclair' && added.verified === 'google', 'the stop landed as a VERIFIED fuel stop with Google\'s identity and name');
  check(wps.indexOf(added) === 1, `inserted by route order, between Basecamp and Granite Diner (index ${wps.indexOf(added)})`);
  check(await page.locator('.place-sheet').count() === 0, 'the card closes on add');

  // 4. no Google listing → still addable, unverified
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Nowhere Cafe', class: 'cafe' }, geometry: { coordinates: [lng, lat + 0.01] } }), on1);
  await page.waitForSelector('.place-sheet', { timeout: 5000 });
  await page.waitForFunction(() => /unverified/.test(document.querySelector('.place-sheet .ps-body')?.textContent ?? ''), null, { timeout: 6000 });
  check((await page.locator('.place-sheet .poi-glyph').textContent()) === '☕', 'a cafe wears the coffee glyph');
  check(!(await page.locator('.place-sheet .ps-foot .btn.gold').isDisabled()), 'no listing: Add is still offered');
  await page.locator('.place-sheet .ps-foot .btn.gold').click();
  await page.waitForTimeout(600);
  trip = await lib(); wps = trip.days[0].waypoints;
  const cafe = wps.find((w) => w.name === 'Nowhere Cafe');
  check(!!cafe && !cafe.placeId && cafe.kind === 'via' && !cafe.fuel, 'it landed as a plain, unverified stop with the OSM name');

  // 5. a POI tap never doubles as click-to-add
  check(await page.locator('.modal.sheet').count() === 0, 'no "Add a stop" naming sheet opened alongside');

  // 5b. a natural feature — a pass on the satellite view — is never checked
  // with Google: it is a placed pin, a photo stop, from the first frame
  const before = calls.length;
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Beartooth Pass', class: 'landform', maki: 'mountain', elevation_ft: 10947 }, geometry: { type: 'Point', coordinates: [lng, lat + 0.02] } }), on1);
  await page.waitForSelector('.place-sheet', { timeout: 5000 });
  await page.waitForTimeout(700);
  const body = await page.locator('.place-sheet').innerText();
  check(calls.length === before, 'no Places request went out for a pass');
  check(/placed pin/.test(body) && !/Checking the listing|unverified/.test(body), 'the card says it is a place on the map, not a failed lookup');
  const pg = await page.locator('.place-sheet .poi-glyph').textContent();
  const pk = await page.locator('.place-sheet .ps-kicker').textContent().catch(() => '');
  check(pg === '⛰' && /10,947 ft/.test(pk), `a peak wears the mountain glyph and its elevation (${pg} · ${pk})`);
  check(/Add as photo stop/.test(await page.locator('.place-sheet .ps-foot .btn.gold').textContent()), 'the add is a photo stop');
  await page.locator('.place-sheet .ps-foot .btn.gold').click();
  await page.waitForTimeout(600);
  trip = await lib(); wps = trip.days[0].waypoints;
  const pass_ = wps.find((w) => w.name === 'Beartooth Pass');
  check(!!pass_ && pass_.kind === 'photo' && pass_.placed === 'rider' && !pass_.placeId && pass_.verified === undefined, `it landed as a PLACED photo stop — not verified, not unverified (${JSON.stringify(pass_ && { kind: pass_.kind, placed: pass_.placed, placeId: pass_.placeId, verified: pass_.verified })})`);
  // a line label (a range) has no point: the tap itself is the place
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Beartooth Mountains', class: 'landform' }, geometry: { type: 'LineString', coordinates: [[lng, lat], [lng + 0.1, lat]] } }, { lng, lat: lat + 0.03 }), on1);
  await page.waitForSelector('.place-sheet', { timeout: 5000 });
  check(/Beartooth Mountains/.test(await page.locator('.place-sheet').innerText()), 'a range (a line label) opens at the tap point');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 6. the nav map is on satellite-streets too
  await page.locator('.modebar button', { hasText: /ride/i }).click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  await page.waitForFunction(() => /satellite-streets/.test(window.__rideMap?.getStyle?.()?.name ?? ''), null, { timeout: 15000 }).catch(() => {});
  const rs = await page.evaluate(() => window.__rideMap?.getStyle?.()?.name ?? null);
  check(/satellite-streets/.test(rs ?? ''), `Ride Mode's satellite is Mapbox's too (${rs})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

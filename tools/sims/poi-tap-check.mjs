// Composite satellite: imagery UNDERNEATH, OpenFreeMap's vector roads / labels /
// POIs on top — so a POI on the satellite view is a real feature a rider can
// tap, resolved against Google Places for the facts, and added to the day.
//
//   · compositeSatellite() keeps only roads / road names / places / POIs from
//     liberty, puts imagery first, recolours type for a dark ground, and
//     names its POI layers in the style metadata
//   · the plan map and the nav map both run it
//   · a tapped POI opens a card: OSM name + class glyph, then Google's match
//     (rating, open now, ✓) when one is close and plausibly the same business
//   · Add lands it in the day by ROUTE order with placeId + verified; a fuel
//     POI lands as a fuel stop; no Google match → added unverified
//   · with no day selected, Add is disabled and says why
//
//   npm run dev    # :5199
//   node tools/sims/poi-tap-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { compositeSatellite } from '../../src/engine/basemaps.js';
import { LIBERTY_MINI } from './fixtures/liberty-mini.mjs';

const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

// 0. the compositor, as a pure function
{
  const esri = { id: 'esri', source: { type: 'raster', tiles: ['https://x/{z}/{y}/{x}'], tileSize: 256 } };
  const c = compositeSatellite(LIBERTY_MINI, esri);
  const ids = c.layers.map((l) => l.id);
  check(c.layers[0].id === 'imagery' && c.layers[0].type === 'raster', 'imagery is the bottom layer');
  check(!ids.some((id) => /background|landuse|water$|building|natural_earth|^park$|park_outline/.test(id)), `fills, relief and park outlines are gone (${ids.join(', ')})`);
  check(['highway_motorway_casing', 'highway_motorway_inner', 'highway_minor', 'highway_name_other', 'place_town', 'place_city', 'poi_z16', 'poi_z14', 'park_label', 'water_name', 'highway-shield-us-interstate'].every((id) => ids.includes(id)), 'roads, road names, places, POIs and park names are kept');
  const sym = c.layers.filter((l) => l.type === 'symbol');
  check(sym.every((l) => l.paint['text-color'] === '#ffffff' && /rgba\(0, 0, 0/.test(l.paint['text-halo-color'])), 'type is white with a dark halo on every label layer');
  const road = c.layers.find((l) => l.id === 'highway_motorway_inner');
  check(road.paint['line-opacity'] === 0.8 && road.paint['line-color'] === '#fc8', 'road lines keep their colour at reduced opacity');
  check(c.metadata.roadbook.composite === true && c.metadata.roadbook.poiLayers.join() === 'poi_z16,poi_z14', `POI layers are named in the metadata (${c.metadata.roadbook.poiLayers.join(', ')})`);
  check(Object.keys(c.sources).join() === 'imagery,openmaptiles' && c.glyphs === LIBERTY_MINI.glyphs, 'two sources, liberty glyphs');
  check(compositeSatellite({ version: 8, sources: {}, layers: [] }, esri) === null, 'a style with no vector source composes to null (the caller falls back)');
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
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.includes('tiles.openfreemap.org/styles/liberty')) return r.fulfill({ json: LIBERTY_MINI });
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
  await page.goto('http://localhost:5199/');
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.trip-card', { timeout: 15000 });
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

  // 1. the plan map is on the composite
  await page.waitForFunction(() => window.__map?.getStyle?.()?.metadata?.roadbook?.composite === true, null, { timeout: 15000 }).catch(() => {});
  const st = await page.evaluate(() => { const s = window.__map.getStyle(); return { composite: s.metadata?.roadbook?.composite, first: s.layers[0]?.id, poi: s.metadata?.roadbook?.poiLayers, imagery: s.metadata?.roadbook?.imagery, hasPoiLayer: !!window.__map.getLayer('poi_z14') }; });
  check(st.composite === true && st.first === 'imagery', `the plan map runs the composite satellite (imagery: ${st.imagery})`);
  check(st.hasPoiLayer && st.poi?.length === 2, 'its POI layers are live symbol layers');
  check(await page.locator('.bs-cur').textContent().then((x) => /Satellite/.test(x)), 'the basemap pill still says Satellite');

  // 2. no day selected: the card opens, Add is disabled and says why
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Sinclair', class: 'fuel', subclass: 'fuel' }, geometry: { coordinates: [lng, lat] } }), on1);
  await page.waitForSelector('.poi-card', { timeout: 5000 });
  check((await page.locator('.poi-card .poi-glyph').textContent()) === '⛽', 'a fuel POI wears the fuel glyph');
  await page.waitForSelector('.poi-card .nb-ver', { timeout: 6000 });
  check(/Sinclair Granite/.test(await page.locator('.poi-facts').textContent().catch(() => '')) || /4\.3/.test(await page.locator('.poi-facts').textContent()), 'Google\'s match is shown with its rating');
  check(await page.locator('.poi-actions .btn.gold').isDisabled(), 'with no day selected, Add is disabled');
  check(/Pick a day/.test(await page.locator('.poi-hint').textContent()), 'and the card says why');
  await page.screenshot({ path: SHOT(`poi-tap-noday-${width}`) });
  await page.locator('.poi-card .mini-edit').click();

  // 3. a day selected: tap → match → Add as fuel stop, by route order, verified
  await page.locator('.ribbon .rchip:not(.trip-seat)').first().click();
  await page.waitForSelector('.wp-row', { timeout: 8000 });
  if (phone) { await page.locator('.panel-tab').click().catch(() => {}); await page.waitForTimeout(300); }
  calls = [];
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Sinclair', class: 'fuel' }, geometry: { coordinates: [lng, lat] } }), on1);
  await page.waitForSelector('.poi-card .nb-ver', { timeout: 6000 });
  check(calls.at(-1)?.category === 'fuel' && /Sinclair/.test(calls.at(-1)?.query) && calls.at(-1)?.radiusMi <= 2, 'the Google lookup is strict-typed to the POI class and tight around the point');
  check(/Add as fuel stop/.test(await page.locator('.poi-actions .btn.gold').textContent()), 'the action names the role the POI implies');
  await page.screenshot({ path: SHOT(`poi-tap-${width}`) });
  await page.locator('.poi-actions .btn.gold').click();
  await page.waitForTimeout(600);
  let trip = await lib();
  let wps = trip.days[0].waypoints;
  const added = wps.find((w) => w.name === 'Sinclair Granite');
  check(!!added && added.fuel === true && added.kind === 'fuel' && added.placeId === 'g-sinclair' && added.verified === 'google', 'the stop landed as a VERIFIED fuel stop with Google\'s identity and name');
  check(wps.indexOf(added) === 1, `inserted by route order, between Basecamp and Granite Diner (index ${wps.indexOf(added)})`);
  check(await page.locator('.poi-card').count() === 0, 'the card closes on add');

  // 4. no Google listing → still addable, unverified
  await page.evaluate(([lng, lat]) => window.__poiTap({ properties: { name: 'Nowhere Cafe', class: 'cafe' }, geometry: { coordinates: [lng, lat + 0.01] } }), on1);
  await page.waitForSelector('.poi-card', { timeout: 5000 });
  await page.waitForFunction(() => /unverified/.test(document.querySelector('.poi-facts')?.textContent ?? ''), null, { timeout: 6000 });
  check((await page.locator('.poi-card .poi-glyph').textContent()) === '☕', 'a cafe wears the coffee glyph');
  check(!(await page.locator('.poi-actions .btn.gold').isDisabled()), 'no listing: Add is still offered');
  await page.locator('.poi-actions .btn.gold').click();
  await page.waitForTimeout(600);
  trip = await lib(); wps = trip.days[0].waypoints;
  const cafe = wps.find((w) => w.name === 'Nowhere Cafe');
  check(!!cafe && !cafe.placeId && cafe.kind === 'via' && !cafe.fuel, 'it landed as a plain, unverified stop with the OSM name');

  // 5. a POI tap never doubles as click-to-add
  check(await page.locator('.modal.sheet').count() === 0, 'no "Add a stop" naming sheet opened alongside');

  // 6. the nav map is on the composite too
  await page.locator('.modebar button', { hasText: /ride/i }).click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  await page.waitForFunction(() => window.__rideMap?.getStyle?.()?.metadata?.roadbook?.composite === true, null, { timeout: 15000 }).catch(() => {});
  const rs = await page.evaluate(() => window.__rideMap?.getStyle?.()?.metadata?.roadbook ?? null);
  check(rs?.composite === true, `Ride Mode's satellite is the composite (imagery: ${rs?.imagery})`);
  await ctx.close();
}

await run(375, 'phone');
await run(1280, 'desktop');
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

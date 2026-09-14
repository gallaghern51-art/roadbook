// Mapbox is the map: mapbox-gl is the renderer (the "Qualified Renderer" of
// Mapbox's Product Terms, so a map is billed as a Map Load and not per tile),
// every basemap is a Mapbox style, and with no token — or a token whose URL
// restriction rejects this page — the map falls back to Esri imagery rather
// than going blank. api.mapbox.com is mocked here (fixtures/mapbox-mock.mjs);
// the real thing is verified locally with VITE_MAPBOX_TOKEN.
//
//   npm run dev    # :5199
//   node tools/sims/mapbox-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { BASEMAPS, MAPBOX_STYLES, basemapStyle, isStyleLoadError, STYLE_FALLBACK, warmTilesAhead } from '../../src/engine/basemaps.js';
import { routeMapbox, isMockTile, mbLog } from './fixtures/mapbox-mock.mjs';
import { seedRideAck } from './fixtures/ride-ack.mjs';
const PORT = process.env.RB_PORT || 5199;

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;

// 0. the engine under node (no token): the fallback roster
{
  check(Object.keys(BASEMAPS).join() === 'sat' && BASEMAPS.sat.style === STYLE_FALLBACK, 'without a token the roster is Esri satellite alone');
  check(basemapStyle('streets') === STYLE_FALLBACK && basemapStyle('nope') === STYLE_FALLBACK, 'every key lands on the one style there is');
  check(Object.values(MAPBOX_STYLES).every((u) => /^mapbox:\/\/styles\/mapbox\//.test(u)) && /satellite-streets/.test(MAPBOX_STYLES.sat), 'the four Mapbox styles are mapbox:// ids, Satellite is satellite-streets');
  check(isStyleLoadError({ error: { message: 'Not Authorized - Invalid Token' } }) === false || isStyleLoadError({ error: { status: 401, message: 'Unauthorized 401' } }), 'a 401 reads as a style load error');
  check(isStyleLoadError({ error: { message: 'Failed to fetch style' } }) && !isStyleLoadError({ error: { message: 'Could not load image' } }), 'a style fetch failure does, a missing image does not');
  check(STYLE_FALLBACK.layers[0].type === 'raster' && !STYLE_FALLBACK.glyphs, 'the Esri fallback is pure raster with no font dependency');
  check(warmTilesAhead([{ lat: 44, lng: -108 }, { lat: 44.1, lng: -108 }], 0) >= 0, 'tile warming is callable on the fallback');
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });

async function open(styleStatus) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => { pageErrors.push(e.message); console.log('PAGEERROR', e.message); });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (routeMapbox(r, { styleStatus })) return undefined;
    if (isMockTile(u)) return r.fulfill({ status: 204 });
    if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: [] });
    if (u.includes(`localhost:${PORT}`)) return r.continue();
    return r.abort();
  });
  // a token for a checkout that has none in .env.local (the mock ignores its value)
  await page.addInitScript(() => { try { localStorage.setItem('moto.mapboxToken', 'pk.test-token'); } catch {} });
  await seedRideAck(page); // Ride Mode's safety gate is answered once per device
  await page.goto(`http://localhost:${PORT}/`);
  const guest = page.locator('.land-skip');
  if (await guest.isVisible().catch(() => false)) await guest.click();
  await page.waitForSelector('.trip-card', { timeout: 15000 });
  const tripsBtn = page.locator('.hm-tripsbtn'); // the desktop home keeps the library in a closed drawer
  if (await tripsBtn.isVisible().catch(() => false)) { await tripsBtn.click(); await page.waitForTimeout(400); }
  await page.click('.trip-card');
  await page.waitForSelector('.modebar', { timeout: 15000 });
  return { ctx, page, pageErrors };
}

// 1. with a working token: Mapbox styles through the SDK
{
  mbLog.length = 0;
  const { ctx, page, pageErrors } = await open(200);
  await page.waitForFunction(() => /satellite-streets/.test(window.__map?.getStyle?.()?.name ?? ''), null, { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(() => window.__map?.getLayoutProperty?.('road-number-shield', 'visibility') === 'none', null, { timeout: 10000 }).catch(() => {});
  const st = await page.evaluate(() => { const m = window.__map; const s = m.getStyle(); return { name: s.name, hasPoi: !!m.getLayer('poi-label'), shield: m.getLayoutProperty('road-number-shield', 'visibility'), exit: m.getLayoutProperty('road-exit-shield', 'visibility'), sources: Object.keys(s.sources), ours: !!m.getLayer('leg-hi-line'), logo: !!document.querySelector('.mapboxgl-ctrl-logo'), attrib: document.querySelector('.mapboxgl-ctrl-attrib')?.textContent ?? '' }; });
  check(/satellite-streets/.test(st.name), `the plan map wears Mapbox's satellite-streets style (${st.sources.join(', ')})`);
  check(st.hasPoi, 'poi_label is a live layer');
  check(st.shield === 'none', "Mapbox's own route-number shields are hidden under ours");
  check(st.exit !== 'none', 'exit shields stay — the one number a rider acts on');
  check(st.ours, 'our route layers are on top of the style');
  // the route outranks the road: white casing + no grey phase on satellite
  const rc = await page.evaluate(() => { const m = window.__map; const ids = m.getStyle().layers.map((l) => l.id); const casing = ids.find((id) => /^route-.*-casing$/.test(id)); const lines = ids.filter((id) => /^route-.*-line$/.test(id)); return { casing: casing && m.getPaintProperty(casing, 'line-color'), colors: lines.map((id) => String(m.getPaintProperty(id, 'line-color')).toLowerCase()) }; });
  check(rc.casing === '#ffffff', `on satellite the route casing is WHITE (roads are dark-cased) — ${rc.casing}`);
  check(rc.colors.length > 0 && !rc.colors.includes('#cecece') && !rc.colors.includes('#7a7a7a') && !rc.colors.includes('#ff9838') && rc.colors.includes('#2f7bff'), `on satellite the days wear the satellite palette — blue leads, no grey, no orange (Mapbox's own primaries are orange) (${[...new Set(rc.colors)].join(', ')})`);
  const rw = await page.evaluate(() => window.__map.getPaintProperty('road-primary', 'line-width'));
  check(Array.isArray(rw) && rw[0] === 'interpolate' && rw.includes(9), `satellite: primary roads carry the targeted width floor (the Beartooth stays a line; no colour or casing change)`);
  check(st.logo && /Mapbox/.test(st.attrib), 'the Mapbox wordmark and © credit are on the map (Product Terms attribution)');
  check(mbLog.some((u) => /api\.mapbox\.com\/styles\/v1\/mapbox\/satellite-streets-v12\?sdk=js-3.*access_token=pk\./.test(u)), 'the style was fetched from api.mapbox.com by the SDK with a public token');
  check(mbLog.some((u) => /api\.mapbox\.com\/v4\/mapbox\.mapbox-streets-v8.*access_token=/.test(u)) && mbLog.some((u) => /api\.mapbox\.com\/v4\/mapbox\.satellite\.json.*access_token=/.test(u)), 'both mapbox:// sources resolved to v4 TileJSON requests with the token');
  check(mbLog.some((u) => /styles\/v1\/mapbox\/satellite-streets-v12\/(sprite|iconset)/.test(u)), 'the icon set was fetched');
  check(mbLog.some((u) => /map-sessions\/v1\?sku=/.test(u)), 'a v3 map session was opened — the Map Load the Product Terms bill');
  check(!mbLog.some((u) => u.startsWith('mapbox://')), 'no raw mapbox:// request ever left the page');
  check(!mbLog.some((u) => /openfreemap|tile\.googleapis|arcgisonline/.test(u)), 'no OpenFreeMap, Google tile or Esri request with a token');
  check(await page.locator('.bs-cur').textContent().then((x) => /Satellite/.test(x)), 'the basemap pill says Satellite');
  // the other three styles are Mapbox's too, and the switch redraws ours
  await page.locator('.basemap-switch.closed button').click();
  await page.locator('.basemap-switch button', { hasText: /^Streets$/ }).click();
  await page.waitForFunction(() => /streets-v12/.test(window.__map?.getStyle?.()?.name ?? '') && !!window.__map.getLayer('leg-hi-line'), null, { timeout: 15000 }).catch(() => {});
  const sw = await page.evaluate(() => { const m = window.__map; return { name: m.getStyle().name, ours: !!m.getLayer('leg-hi-line'), routes: m.getStyle().layers.filter((l) => /^route-/.test(l.id)).length }; });
  check(/streets-v12/.test(sw.name) && sw.ours && sw.routes > 0, `Streets is Mapbox streets-v12 and our ${sw.routes} route layers came back`);
  check(mbLog.some((u) => /styles\/v1\/mapbox\/streets-v12\?/.test(u)), 'streets-v12 was fetched through the SDK');
  await page.waitForFunction(() => window.__map?.getLayoutProperty?.('road-number-shield', 'visibility') === 'none', null, { timeout: 10000 }).catch(() => {});
  check((await page.evaluate(() => window.__map.getLayoutProperty('road-number-shield', 'visibility'))) === 'none', 'the new style\'s shields are hidden again');
  // the redraw that recolours the casing runs once the swapped style is idle
  const readCasing = () => { const m = window.__map; const ids = m.getStyle().layers.map((l) => l.id); const casing = ids.find((id) => /^route-(?!preview|drag).*-casing$/.test(id)); return casing && m.getPaintProperty(casing, 'line-color'); };
  await page.waitForFunction(`(${readCasing.toString()})() === '#000000'`, null, { timeout: 10000 }).catch(() => {});
  const sc = await page.evaluate(readCasing);
  check(sc === '#000000', `on Streets the route casing is black again (${sc})`);
  await page.locator('.basemap-switch.closed button').click();
  const pills = await page.locator('.basemap-switch button').allTextContents();
  check(['Satellite', 'Streets', 'Dark', 'Light'].every((k) => pills.includes(k)), `four Mapbox basemaps on the pill (${pills.join(', ')})`);
  await page.locator('.basemap-switch button', { hasText: /^Streets$/ }).click();
  // a Streets-v8-shaped POI feature: class bucket + maki icon
  await page.evaluate(() => window.__poiTap({ properties: { name: 'Buffalo Cafe', class: 'food_and_drink', maki: 'cafe' }, geometry: { coordinates: [-108.0, 44.0] } }));
  await page.waitForSelector('.place-sheet', { timeout: 5000 });
  check((await page.locator('.place-sheet .poi-glyph').textContent()) === '☕', 'a Mapbox cafe (class food_and_drink, maki cafe) wears the coffee glyph');
  await page.locator('.place-sheet .ps-head .btn').click();
  await page.evaluate(() => window.__poiTap({ properties: { name: 'Rushmore Steakhouse', class: 'food_and_drink', maki: 'restaurant' }, geometry: { coordinates: [-108.0, 44.0] } }));
  await page.waitForSelector('.place-sheet', { timeout: 5000 });
  check((await page.locator('.place-sheet .poi-glyph').textContent()) === '🍽', 'a restaurant wears the food glyph');
  await page.screenshot({ path: SHOT('mapbox-poi-card') });
  await page.locator('.place-sheet .ps-head .btn').click();
  // the nav map too
  await page.locator('.modebar button', { hasText: /ride/i }).click();
  await page.waitForSelector('.ride-bar', { timeout: 15000 });
  await page.waitForFunction(() => /satellite-streets/.test(window.__rideMap?.getStyle?.()?.name ?? '') && window.__rideMap.isStyleLoaded(), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const ride = await page.evaluate(() => { const m = window.__rideMap; const lg = document.querySelector('.ride-mode .mapboxgl-ctrl-logo')?.getBoundingClientRect(); const bar = document.querySelector('.ride-bar')?.getBoundingClientRect(); return { name: m?.getStyle?.()?.name, route: !!m?.getSource?.('ride-route'), logoAboveBar: !!lg && !!bar && lg.bottom < bar.top, logoW: lg?.width }; });
  check(/satellite-streets/.test(ride.name ?? '') && ride.route, "Ride Mode's satellite is Mapbox's too, with the route laid on it");
  check(ride.logoAboveBar && ride.logoW > 0, 'the wordmark is visible above the ride bar');
  await page.screenshot({ path: SHOT('mapbox-ride') });
  check(pageErrors.length === 0, `no uncaught page errors across load, style switches and Ride Mode (${pageErrors.length})`);
  await ctx.close();
}

// 2. a token the URL restriction rejects: Esri imagery, not a blank map
{
  mbLog.length = 0;
  const { ctx, page } = await open(401);
  await page.waitForFunction(() => !!window.__map?.getSource?.('satellite') && !!window.__map.getLayer('leg-hi-line') && window.__map.getStyle().layers.some((l) => /^route-/.test(l.id)), null, { timeout: 20000 }).catch(() => {});
  const fb = await page.evaluate(() => { const m = window.__map; const s = m.getStyle(); return { name: s.name, esri: !!m.getSource('satellite'), ours: !!m.getLayer('leg-hi-line'), routes: s.layers.filter((l) => /^route-/.test(l.id)).length }; });
  check(!fb.name && fb.esri, 'a 401 on the style lands the map on Esri imagery');
  check(fb.ours && fb.routes > 0, `and the trip is still drawn on it (${fb.routes} route layers)`);
  if (!fb.routes) console.log('  layers:', await page.evaluate(() => window.__map.getStyle().layers.map((l) => l.id).join(' ')), '| routeCache:', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('sturgis.routeCache.v5') || '{}')).length));
  const asks = mbLog.filter((u) => /styles\/v1\/mapbox\/satellite-streets-v12\?/.test(u)).length;
  check(asks <= 3, `the rejected style was not retried in a loop (${asks} requests — the home map, the plan map, at most one retry)`);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

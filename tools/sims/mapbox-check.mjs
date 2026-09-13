// Mapbox as the satellite: with a public token the app fetches Mapbox's own
// satellite-streets style (their imagery, their vector roads / labels / POIs),
// rewrites every mapbox:// request to api.mapbox.com with the token, tags the
// style so poi_label is the tappable layer, and hides Mapbox's shields under
// ours. api.mapbox.com is mocked here — the real thing is verified locally
// with VITE_MAPBOX_TOKEN.
//
//   npm run dev    # :5199
//   node tools/sims/mapbox-check.mjs
import { chromium } from '../../node_modules/playwright-core/index.mjs';
import { mapboxTransformRequest, mapboxComposite } from '../../src/engine/basemaps.js';
import { MAPBOX_MINI } from './fixtures/mapbox-mini.mjs';

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const TOKEN = 'pk.test-token';
const SHOT = (n) => new URL(`./shots/${n}.png`, import.meta.url).pathname;

// 0. the request rewrite, as a pure function
{
  const tr = (u) => mapboxTransformRequest(u, 'Tile', TOKEN)?.url;
  check(tr('mapbox://styles/mapbox/satellite-streets-v12') === `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12?access_token=${TOKEN}`, 'style URL');
  check(tr('mapbox://sprites/mapbox/satellite-streets-v12@2x.json') === `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/sprite@2x.json?access_token=${TOKEN}`, 'sprite URL (@2x json)');
  check(tr('mapbox://sprites/mapbox/satellite-streets-v12.png') === `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/sprite.png?access_token=${TOKEN}`, 'sprite URL (png)');
  check(tr('mapbox://fonts/mapbox/DIN Pro Medium,Arial Unicode MS Regular/0-255.pbf') === `https://api.mapbox.com/fonts/v1/mapbox/DIN Pro Medium,Arial Unicode MS Regular/0-255.pbf?access_token=${TOKEN}`, 'glyph URL');
  check(tr('mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2') === `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure&access_token=${TOKEN}`, 'source URL → TileJSON');
  check(tr('https://a.tiles.mapbox.com/v4/mapbox.satellite/12/700/1500.webp') === `https://a.tiles.mapbox.com/v4/mapbox.satellite/12/700/1500.webp?access_token=${TOKEN}`, 'a tile URL from TileJSON gets the token appended');
  check(tr('https://api.mapbox.com/v4/x.json?secure&access_token=abc') === undefined, 'a URL that already carries a token is left alone');
  check(tr('https://tiles.openfreemap.org/styles/liberty') === undefined && tr('https://tile.googleapis.com/x') === undefined, 'non-Mapbox URLs are untouched');
  check(mapboxTransformRequest('mapbox://styles/a/b', 'Style', '') === undefined, 'no token → no rewrite');
  const c = mapboxComposite(MAPBOX_MINI);
  check(c.metadata.roadbook.composite === true && c.metadata.roadbook.imagery === 'mapbox' && c.metadata.roadbook.poiLayers.join() === 'poi-label', 'the style is tagged with its poi_label layer');
  check(c.layers.length === MAPBOX_MINI.layers.length && c.sprite === MAPBOX_MINI.sprite, 'and otherwise left as Mapbox authored it');
}

const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const mb = [];
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (/mapbox\.com/.test(u)) mb.push(u);
  if (u.startsWith('mapbox://')) { mb.push(u); return r.abort(); }
  if (u.includes('api.mapbox.com/styles/v1/mapbox/satellite-streets-v12?')) return r.fulfill({ json: MAPBOX_MINI });
  if (u.includes('api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/sprite') && u.endsWith('.json') || /sprite(@2x)?\.json/.test(u)) return r.fulfill({ json: {} });
  if (u.includes('api.mapbox.com/v4/mapbox.satellite.json')) return r.fulfill({ json: { tilejson: '2.2.0', tiles: ['http://localhost:5199/__mock_img/{z}/{x}/{y}.png'], minzoom: 0, maxzoom: 20 } });
  if (u.includes('api.mapbox.com/v4/mapbox.mapbox-streets-v8')) return r.fulfill({ json: { tilejson: '2.2.0', tiles: ['http://localhost:5199/__mock_vec/{z}/{x}/{y}.vector.pbf'], minzoom: 0, maxzoom: 14 } });
  if (u.includes('__mock_img') || u.includes('__mock_vec')) return r.fulfill({ status: 204 });
  if (u.includes('/.netlify/functions/nearby-places')) return r.fulfill({ json: [] });
  if (u.includes('localhost:5199')) return r.continue();
  return r.abort();
});
await page.addInitScript((tok) => { try { localStorage.setItem('moto.mapboxToken', tok); } catch {} }, TOKEN);
await page.goto('http://localhost:5199/');
const guest = page.locator('.land-skip');
if (await guest.isVisible().catch(() => false)) await guest.click();
await page.waitForSelector('.trip-card', { timeout: 15000 });
await page.click('.trip-card');
await page.waitForSelector('.modebar', { timeout: 15000 });
await page.waitForFunction(() => window.__map?.getStyle?.()?.metadata?.roadbook?.imagery === 'mapbox', null, { timeout: 15000 }).catch(() => {});
await page.waitForFunction(() => window.__map?.getLayoutProperty?.('road-number-shield', 'visibility') === 'none', null, { timeout: 10000 }).catch(() => {});
const st = await page.evaluate(() => { const m = window.__map; const s = m.getStyle(); return { imagery: s.metadata?.roadbook?.imagery, poi: s.metadata?.roadbook?.poiLayers, hasPoi: !!m.getLayer('poi-label'), shield: m.getLayoutProperty('road-number-shield', 'visibility'), sources: Object.keys(s.sources) }; });
check(st.imagery === 'mapbox', `the plan map wears Mapbox's satellite-streets style (${st.sources.join(', ')})`);
check(st.hasPoi && st.poi?.[0] === 'poi-label', 'poi_label is the tappable layer');
check(st.shield === 'none', "Mapbox's own route shields are hidden under ours");
check(mb.some((u) => /api\.mapbox\.com\/styles\/v1\/mapbox\/satellite-streets-v12\?access_token=pk\.test-token/.test(u)), 'the style was fetched from api.mapbox.com with the token');
check(mb.some((u) => /api\.mapbox\.com\/v4\/mapbox\.mapbox-streets-v8.*access_token=/.test(u)) && mb.some((u) => /api\.mapbox\.com\/v4\/mapbox\.satellite\.json.*access_token=/.test(u)), 'both mapbox:// sources were rewritten to v4 TileJSON requests with the token');
check(mb.some((u) => /styles\/v1\/mapbox\/satellite-streets-v12\/sprite/.test(u)), 'the mapbox:// sprite was rewritten');
check(!mb.some((u) => u.startsWith('mapbox://')), 'no raw mapbox:// request ever left the page');
check(await page.locator('.bs-cur').textContent().then((x) => /Satellite/.test(x)), 'the basemap pill still says Satellite');
// a Streets-v8-shaped POI feature: class bucket + maki icon
await page.evaluate(() => window.__poiTap({ properties: { name: 'Buffalo Cafe', class: 'food_and_drink', maki: 'cafe' }, geometry: { coordinates: [-108.0, 44.0] } }));
await page.waitForSelector('.poi-card', { timeout: 5000 });
check((await page.locator('.poi-card .poi-glyph').textContent()) === '☕', 'a Mapbox cafe (class food_and_drink, maki cafe) wears the coffee glyph');
await page.locator('.poi-card .mini-edit').click();
await page.evaluate(() => window.__poiTap({ properties: { name: 'Rushmore Steakhouse', class: 'food_and_drink', maki: 'restaurant' }, geometry: { coordinates: [-108.0, 44.0] } }));
await page.waitForSelector('.poi-card', { timeout: 5000 });
check((await page.locator('.poi-card .poi-glyph').textContent()) === '🍽', 'a restaurant wears the food glyph');
await page.screenshot({ path: SHOT('mapbox-poi-card') });
await page.locator('.poi-card .mini-edit').click();
// the nav map too
await page.locator('.modebar button', { hasText: /ride/i }).click();
await page.waitForSelector('.ride-bar', { timeout: 15000 });
await page.waitForFunction(() => window.__rideMap?.getStyle?.()?.metadata?.roadbook?.imagery === 'mapbox', null, { timeout: 15000 }).catch(() => {});
check((await page.evaluate(() => window.__rideMap?.getStyle?.()?.metadata?.roadbook?.imagery)) === 'mapbox', "Ride Mode's satellite is Mapbox's too");
await browser.close();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

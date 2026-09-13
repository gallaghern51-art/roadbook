// One mocked Mapbox for the sims: mapbox-gl resolves every mapbox:// itself
// (style → api.mapbox.com/styles/v1, sprite, fonts, TileJSON, the v3 billing
// session, telemetry) and this answers each with a mini style whose name
// carries the style id, so a sim can tell Satellite from Streets.
import { MAPBOX_MINI } from './mapbox-mini.mjs';

const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tilejson = (path, ext) => ({ tilejson: '2.2.0', tiles: [`http://localhost:5199/${path}/{z}/{x}/{y}.${ext}`], minzoom: 0, maxzoom: 16, attribution: '© Mapbox © OpenStreetMap', mapbox_logo: true });

/** Every Mapbox request the page makes, in order. */
export const mbLog = [];

/** Route handler: answers Mapbox hosts, returns false for everything else. `styleStatus` fails the style fetch (a restricted token → 401). */
export function routeMapbox(r, { styleStatus = 200 } = {}) {
  const u = r.request().url();
  if (!/mapbox\.com/.test(u) && !u.startsWith('mapbox://')) return false;
  mbLog.push(u);
  let m;
  if (u.startsWith('mapbox://')) { r.abort(); return true; }
  if ((m = /api\.mapbox\.com\/styles\/v1\/mapbox\/([a-z0-9-]+)\?/.exec(u))) {
    if (styleStatus !== 200) { r.fulfill({ status: styleStatus, json: { message: 'Not Authorized - Invalid Token' } }); return true; }
    r.fulfill({ json: { ...MAPBOX_MINI, name: `Mapbox mini ${m[1]}` } });
    return true;
  }
  if (/\/sprite(@2x)?\.json/.test(u)) { r.fulfill({ json: {} }); return true; }
  if (/\/sprite(@2x)?\.png/.test(u)) { r.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }); return true; }
  if (/api\.mapbox\.com\/v4\/mapbox\.satellite\.json/.test(u)) { r.fulfill({ json: tilejson('__mock_img', 'png') }); return true; }
  if (/api\.mapbox\.com\/v4\/mapbox\.mapbox-streets-v8/.test(u)) { r.fulfill({ json: tilejson('__mock_vec', 'vector.pbf') }); return true; }
  if (/api\.mapbox\.com\/v4\/mapbox\.mapbox-terrain-dem-v1/.test(u)) { r.fulfill({ json: tilejson('__mock_dem', 'png') }); return true; }
  r.fulfill({ status: 204 }); // fonts, iconset.pbf (v3's sprite), map-sessions, events — nothing to say
  return true;
}
/** The mock tile URLs the TileJSON hands out (empty tiles). */
export const isMockTile = (u) => /__mock_(img|vec|dem)\//.test(u);

/** A map-shaped stub over a style JSON, for the pure helpers (hideNativeRoadShields, poiLayerIds). */
export function fakeMap(style) {
  const vis = {};
  const paint = {}; // id → { prop: value } as set through the API
  const zoom = {}; // id → [min, max]
  return {
    getStyle: () => style,
    getLayer: (id) => style.layers.find((l) => l.id === id),
    getLayoutProperty: (id, k) => (k === 'visibility' ? vis[id] : undefined),
    setLayoutProperty: (id, k, v) => { if (k === 'visibility') vis[id] = v; },
    setPaintProperty: (id, k, v) => { (paint[id] ??= {})[k] = v; },
    getPaintProperty: (id, k) => paint[id]?.[k] ?? style.layers.find((l) => l.id === id)?.paint?.[k],
    setLayerZoomRange: (id, a, b) => { zoom[id] = [a, b]; },
    vis, paint, zoom,
  };
}

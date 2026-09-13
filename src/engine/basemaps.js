// Shared basemap styles — used by the planning map and the Ride Mode nav map.
//
// Mapbox is the map (owner, Sep 13 2026: "switch from open free maps to mapbox
// in order to have better tiles for clicking locations… since mapbox wants you
// to use their SDK we will move away from openfree maps"). The renderer is
// mapbox-gl — Mapbox's Product Terms (§2.8.3, §3.58) bill a map drawn by
// Mapbox GL JS as a Map Load and a map drawn by anything else per tile
// request, so the SDK is the cheap AND the sanctioned path. Every basemap is a
// Mapbox style: satellite-streets is the layered one — their imagery
// underneath, their vector roads / labels / POIs on top, so a POI is a symbol
// feature with a name and a class the map can hit-test (Tesla's grammar).
//
// The token is PUBLIC (pk., the default public scopes, URL-restricted in the
// Mapbox console) — VITE_MAPBOX_TOKEN at build time, or in dev a localStorage
// override (`moto.mapboxToken`) so a phone or a sim can try one without a
// rebuild. Without a token mapbox-gl still renders any non-Mapbox style, so
// the app falls back to Esri imagery rather than a blank map.

import { haversineMiles } from './tripEngine.js';

const ENV = import.meta.env ?? {}; // `?? {}` so node check scripts can import this
export const MAPBOX_TOKEN = ENV.VITE_MAPBOX_TOKEN
  || (ENV.DEV ? (() => { try { return localStorage.getItem('moto.mapboxToken') || ''; } catch { return ''; } })() : '');
export const MAPBOX_ON = !!MAPBOX_TOKEN;
// The token rides on each Map as `accessToken` (MapView, RideMode) rather than
// mapboxgl.accessToken here, so this module never imports the renderer — the
// node check scripts and sims import it for the pure helpers.

// Mapbox's own styles. mapbox-gl resolves mapbox:// itself (style, sprite,
// glyphs, TileJSON, tiles) and puts the token on every request.
export const MAPBOX_STYLES = {
  sat: 'mapbox://styles/mapbox/satellite-streets-v12',
  streets: 'mapbox://styles/mapbox/streets-v12',
  dark: 'mapbox://styles/mapbox/dark-v11',
  light: 'mapbox://styles/mapbox/light-v11',
};

// No-token fallback: Esri imagery + road network + place labels, all raster
// (nothing to tap). Also where a map lands if the Mapbox style fails to load.
export const STYLE_SATELLITE = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    'esri-roads': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,
    },
    'esri-places': {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,
    },
  },
  layers: [
    { id: 'satellite', type: 'raster', source: 'satellite' },
    { id: 'esri-roads', type: 'raster', source: 'esri-roads', paint: { 'raster-opacity': 0.9 } },
    { id: 'esri-places', type: 'raster', source: 'esri-places' },
  ],
};
export const STYLE_FALLBACK = STYLE_SATELLITE;

export const BASEMAPS = MAPBOX_ON
  ? {
    sat: { label: 'Satellite', style: MAPBOX_STYLES.sat },
    streets: { label: 'Streets', style: MAPBOX_STYLES.streets },
    dark: { label: 'Dark', style: MAPBOX_STYLES.dark },
    light: { label: 'Light', style: MAPBOX_STYLES.light },
  }
  : { sat: { label: 'Satellite', style: STYLE_SATELLITE } };

/** The style for a basemap key; unknown or unavailable keys land on Satellite. */
export function basemapStyle(key) {
  return BASEMAPS[key]?.style ?? BASEMAPS.sat.style;
}

// Mapbox GL fires `error` for a style that will not load (401/403 = token or
// URL restriction, 404 = style id). Answers whether an error is that.
export function isStyleLoadError(e) {
  const msg = String(e?.error?.message ?? e?.message ?? '');
  return /style|401|403|404|access token/i.test(msg);
}

/** POI symbol layers of the current style (Mapbox Streets' `poi_label`), or [] on a raster fallback. */
export function poiLayerIds(map) {
  try {
    return (map.getStyle()?.layers ?? [])
      .filter((l) => l.type === 'symbol' && l['source-layer'] === 'poi_label')
      .map((l) => l.id);
  } catch { return []; }
}

/** Named natural features (peaks, passes, ranges, lakes, falls — Mapbox Streets' `natural_label`), or [] on raster. */
export function naturalLayerIds(map) {
  try {
    return (map.getStyle()?.layers ?? [])
      .filter((l) => l.type === 'symbol' && l['source-layer'] === 'natural_label' && !/continent/.test(l.id))
      .map((l) => l.id);
  } catch { return []; }
}
/** Everything a finger can name on the map: businesses AND the natural features a rider stops for. */
export function tappableLayerIds(map) {
  return [...poiLayerIds(map), ...naturalLayerIds(map)];
}

// ---- roads on satellite ----
// Mapbox's satellite-streets is tuned for cities: its road lines are a
// hairline of 80% grey at 0.8 alpha (about 1.2px at zoom 8 and no casing
// below zoom 9), which vanishes into forest, rock and snow — the Beartooth
// Highway was invisible on the Sturgis template (owner: "satellite view
// doesn't carry roads like the beartooth highway, why is that?"). Streets
// draws the same roads in solid white on a dark casing. This gives satellite
// the same legibility: a brighter, opaque line with a floor on its width at
// touring zooms, and the casing from zoom 6. Line paint changes are safe at
// any time after load (the placement gotcha is symbol layers only); called
// from the same idle handler as the shield pass so it survives setStyle.
const ROAD_MAIN = /^(road|bridge|tunnel)-(motorway-trunk|primary|secondary-tertiary)(-2)?$/;
const ROAD_CASE = /^(road|bridge|tunnel)-(motorway-trunk|primary|secondary-tertiary)(-2)?-case$/;
const FADE = ['interpolate', ['linear'], ['zoom'], 13, 1, 15, 0]; // the style's own: at street zoom the imagery IS the road
// widths a step under our route line (3–4.5px + casing), so the road never
// out-weighs the route drawn on it
const MAJOR_W = ['interpolate', ['exponential', 1.5], ['zoom'], 3, 1, 6, 1.8, 9, 2.6, 12, 3.6, 18, 22, 22, 220];
const MINOR_W = ['interpolate', ['exponential', 1.5], ['zoom'], 6, 0, 8, 1.3, 10, 2, 12, 2.8, 18, 20, 22, 200];
export function emphasizeSatelliteRoads(map) {
  let style;
  try { style = map.getStyle(); } catch { return 0; }
  if (!/satellite/i.test(style?.name ?? '')) return 0;
  let touched = 0;
  for (const layer of style.layers ?? []) {
    if (layer.type !== 'line') continue;
    const major = /motorway-trunk|primary/.test(layer.id);
    try {
      if (ROAD_MAIN.test(layer.id)) {
        map.setPaintProperty(layer.id, 'line-color', 'hsl(40, 12%, 86%)'); // light, not white: white is the route's casing
        map.setPaintProperty(layer.id, 'line-opacity', FADE);
        map.setPaintProperty(layer.id, 'line-width', major ? MAJOR_W : MINOR_W);
        touched += 1;
      } else if (ROAD_CASE.test(layer.id)) {
        // the casing is a HOLLOW line (gap = the road, width = the rim)
        map.setLayerZoomRange(layer.id, major ? 5 : 8, 24);
        map.setPaintProperty(layer.id, 'line-color', 'hsla(0, 0%, 0%, 0.8)');
        map.setPaintProperty(layer.id, 'line-opacity', FADE);
        map.setPaintProperty(layer.id, 'line-gap-width', major ? MAJOR_W : MINOR_W);
        map.setPaintProperty(layer.id, 'line-width', ['interpolate', ['exponential', 1.5], ['zoom'], 5, 1, 12, 1.6, 22, 2.4]);
        touched += 1;
      }
    } catch { /* the style moved on under us */ }
  }
  return touched;
}

// ---- the basemap's own route shields ----
// We draw shields on the route (RouteShields.jsx) at OUR spacing, on the road
// the rider is actually on. Mapbox posts its own on every numbered road at its
// own spacing, so the two together read as clutter — what the owner saw in
// Streets: "there is the underlying road map native icon, ideally I would
// like those removed." A vector style has a layer to reach into, so this is
// exact: hide `road-number-shield` and leave road NAMES, place labels and
// everything else alone. EXIT shields stay — "my exit is exit 99" is the one
// number on the map a rider acts on and nothing of ours replaces it.
//
// Idempotent and cheap to call again: run it after every style application,
// since setStyle replaces the layer list wholesale.
export function hideNativeRoadShields(map) {
  let layers;
  try { layers = map.getStyle()?.layers ?? []; } catch { return 0; }
  let hidden = 0;
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;
    if (/exit/i.test(layer.id)) continue;
    // by id (Mapbox: `road-number-shield`) and by artwork, so a style that
    // names its layers differently but draws from a shield sprite is caught
    const icon = JSON.stringify(layer.layout?.['icon-image'] ?? '');
    if (!/shield/i.test(layer.id) && !/shield|interstate/i.test(icon)) continue;
    try {
      if (map.getLayoutProperty(layer.id, 'visibility') === 'none') continue;
      map.setLayoutProperty(layer.id, 'visibility', 'none');
      hidden += 1;
    } catch { /* the style moved on under us — the next pass gets it */ }
  }
  return hidden;
}

// The light-gray "return"/"prep" phases disappear on a light basemap — swap in dark tones.
export const LIGHT_SAFE = { return: '#1a1a1a', prep: '#5a5a5a' };
// …and on SATELLITE, where the roads themselves are drawn light with a dark
// casing (emphasizeSatelliteRoads), a grey route reads as just another road
// (owner: "the contrast against the grey route [is] impossible to see your
// route vs regular road"). Saturated stand-ins: the route is the one thing on
// a satellite map that is not a colour the ground has.
export const SAT_SAFE = { return: '#4f9cff', prep: '#b48cff' };

// ---- look-ahead tile warming (Ride Mode) ----
// Only the Esri fallback is plain tile URLs we can prefetch into the browser
// HTTP cache. On Mapbox the tiles come from TileJSON and mapbox-gl's own tile
// cache (maxTileCacheSize on the nav map) holds the ridden corridor.
const ESRI_WARM_LAYERS = [
  (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
];
let warmedTiles = new Set();

function tileXY(lat, lng, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [x, y];
}

// chain: [{lat,lng}] route geometry · fromIdx: rider's current segment.
// Warms the next `miles` of route at nav zooms. Fire-and-forget; failures ignored.
export function warmTilesAhead(chain, fromIdx, { miles = 12, zooms = [13, 14], cap = 60 } = {}) {
  if (MAPBOX_ON) return 0;
  if (!chain?.length) return 0;
  if (warmedTiles.size > 5000) warmedTiles = new Set();
  const layers = ESRI_WARM_LAYERS;
  const urls = [];
  let dist = 0;
  for (let i = Math.max(0, fromIdx); i < chain.length - 1 && dist < miles && urls.length < cap; i++) {
    dist += haversineMiles(chain[i], chain[i + 1]);
    for (const z of zooms) {
      const [x, y] = tileXY(chain[i].lat, chain[i].lng, z);
      layers.forEach((mk, li) => {
        const key = `${z}/${x}/${y}/${li}`;
        if (warmedTiles.has(key)) return;
        warmedTiles.add(key);
        urls.push(mk(z, x, y));
      });
    }
  }
  for (const u of urls.slice(0, cap)) {
    fetch(u, { priority: 'low' }).catch(() => { /* cache warming only */ });
  }
  return Math.min(urls.length, cap);
}

// ---- 3D terrain ----
// Mapbox's DEM with a token (covered by the Map Load like every other tile);
// the AWS/Mapzen terrarium DEM (free, no key) on the fallback.
const DEM_SOURCE_ID = 'terrain-dem';
const HILLSHADE_ID = 'terrain-hillshade';
const DEM_SOURCE = MAPBOX_ON
  ? { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 }
  : {
    type: 'raster-dem',
    tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    attribution: 'Elevation: Mapzen/AWS Open Data',
  };

// Idempotent: safe to call from every redraw. setStyle() wipes sources, so the
// draw path re-asserts terrain state after any style switch.
export function ensureTerrain(map, on, { exaggeration = 1.5 } = {}) {
  if (!map.isStyleLoaded()) return;
  if (on) {
    if (!map.getSource(DEM_SOURCE_ID)) map.addSource(DEM_SOURCE_ID, DEM_SOURCE);
    if (!map.getLayer(HILLSHADE_ID)) {
      // Sit the shading under roads/labels so they stay crisp.
      const layers = map.getStyle().layers ?? [];
      const beforeId = layers.find((l) => l.type === 'symbol' || l.type === 'line' || l.id === 'esri-roads')?.id;
      map.addLayer({
        id: HILLSHADE_ID,
        type: 'hillshade',
        source: DEM_SOURCE_ID,
        paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#0b0e12' },
      }, beforeId);
    }
    if (!map.getTerrain()) map.setTerrain({ source: DEM_SOURCE_ID, exaggeration });
  } else {
    if (map.getTerrain()) map.setTerrain(null);
    if (map.getLayer(HILLSHADE_ID)) map.removeLayer(HILLSHADE_ID);
  }
}

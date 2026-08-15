// Shared basemap styles — used by the planning map and the Ride Mode nav map.

import { haversineMiles } from './tripEngine.js';

export const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
export const STYLE_STREETS = 'https://tiles.openfreemap.org/styles/liberty';
export const STYLE_FALLBACK = STYLE_STREETS;
export const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';

// Hybrid satellite: Esri imagery + road network + city/place labels on top.
export const STYLE_SATELLITE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
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

export const BASEMAPS = {
  sat: { label: 'Satellite', style: STYLE_SATELLITE },
  streets: { label: 'Streets', style: STYLE_STREETS },
  dark: { label: 'Dark', style: STYLE_DARK },
  light: { label: 'Light', style: STYLE_LIGHT },
};

// ---- Google Map Tiles API (2D raster sessions) ----
// Needs a client-side key (VITE_GOOGLE_MAPS_KEY at build time) and the
// "Map Tiles API" enabled on the Google project. Everything degrades to the
// free basemaps above when the key is absent or a session can't be created.

export const GOOGLE_KEY = import.meta.env.VITE_GOOGLE_MAPS_KEY || '';
const GT_CACHE = 'moto.gtiles.v1';

// mapType key → createSession body. hybrid = satellite imagery + road overlay.
const G_SESSION_SPECS = {
  hybrid: { mapType: 'satellite', layerTypes: ['layerRoadmap'] },
  roadmap: { mapType: 'roadmap' },
};

function loadGtCache() {
  try { return JSON.parse(localStorage.getItem(GT_CACHE) || '{}'); } catch { return {}; }
}

// Sessions last ~2 weeks; treat anything with <1 day left as expired.
function freshSession(kind) {
  const rec = loadGtCache()[kind];
  return rec && rec.expiry * 1000 > Date.now() + 86_400_000 ? rec : null;
}

function styleFromSession(kind, rec) {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      gtiles: {
        type: 'raster',
        tiles: [`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${rec.session}&key=${GOOGLE_KEY}`],
        tileSize: 256,
        maxzoom: 22,
        attribution: '© Google',
      },
    },
    layers: [{ id: 'gtiles', type: 'raster', source: 'gtiles' }],
  };
}

// Sync path: style immediately if a session is already cached (map init).
export function cachedGoogleStyle(kind) {
  if (!GOOGLE_KEY) return null;
  const rec = freshSession(kind);
  return rec ? styleFromSession(kind, rec) : null;
}

// Async path: create/refresh the session, cache it, return the style.
export async function googleStyle(kind) {
  if (!GOOGLE_KEY) return null;
  const hit = freshSession(kind);
  if (hit) return styleFromSession(kind, hit);
  const spec = G_SESSION_SPECS[kind];
  if (!spec) return null;
  const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${GOOGLE_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...spec, language: 'en-US', region: 'US' }),
  });
  if (!res.ok) throw new Error(`tiles session ${res.status}`);
  const json = await res.json();
  const rec = { session: json.session, expiry: Number(json.expiry) };
  try {
    const c = loadGtCache();
    c[kind] = rec;
    localStorage.setItem(GT_CACHE, JSON.stringify(c));
  } catch { /* cache full — session still usable this page-load */ }
  return styleFromSession(kind, rec);
}

// The light-gray "return"/"prep" phases disappear on a light basemap — swap in dark tones.
export const LIGHT_SAFE = { return: '#0f5875', prep: '#4a5866' };

// ---- 3D terrain (AWS Open Data / Mapzen terrarium DEM — free, no key) ----

const DEM_SOURCE_ID = 'terrain-dem';
const HILLSHADE_ID = 'terrain-hillshade';
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Idempotent: safe to call from every redraw. setStyle() wipes sources, so the
// draw path re-asserts terrain state after any style switch.
// ---- look-ahead tile warming (Ride Mode) ----
// The satellite basemap is plain raster URLs (Esri), so fetching a tile fills
// the browser HTTP cache and MapLibre gets an instant hit when the camera
// arrives. We warm the corridor the rider is about to ride through.

const ESRI_WARM_LAYERS = [
  (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`,
];

// Warm whichever source the nav map actually renders: Google hybrid when a
// tile session is cached, the Esri pair otherwise.
function navWarmLayers() {
  const g = cachedGoogleStyle('hybrid');
  if (g) {
    const tpl = g.sources.gtiles.tiles[0];
    return [(z, x, y) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y)];
  }
  return ESRI_WARM_LAYERS;
}
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
  if (!chain?.length) return 0;
  if (warmedTiles.size > 5000) warmedTiles = new Set();
  const layers = navWarmLayers();
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

export function ensureTerrain(map, on, { exaggeration = 1.5 } = {}) {
  if (!map.isStyleLoaded()) return;
  if (on) {
    if (!map.getSource(DEM_SOURCE_ID)) {
      map.addSource(DEM_SOURCE_ID, {
        type: 'raster-dem',
        tiles: [DEM_TILES],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 15,
        attribution: 'Elevation: Mapzen/AWS Open Data',
      });
    }
    if (!map.getLayer(HILLSHADE_ID)) {
      // Sit the shading under roads/labels so they stay crisp.
      const layers = map.getStyle().layers ?? [];
      const beforeId = layers.find((l) => l.type === 'symbol' || l.id === 'esri-roads')?.id;
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

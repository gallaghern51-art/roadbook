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
const GT_CACHE = 'moto.gtiles.v2';
try { localStorage.removeItem('moto.gtiles.v1'); } catch { /* older, unstyled sessions */ }

// mapType key → createSession body. hybrid = satellite imagery + road overlay.
const G_SESSION_SPECS = {
  hybrid: { mapType: 'satellite', layerTypes: ['layerRoadmap'] },
  roadmap: { mapType: 'roadmap' },
};

// Google bakes its own route shields into the roadmap layer, and we now draw
// our own on top — so the rider gets two of everything, at Google's spacing
// rather than ours (owner, Aug 16 2026: "on street mode there is the underlying
// road map native icon, ideally I would like those removed"). The tiles are one
// flat image with no layer to reach into, so the only door is asking Google not
// to draw them: `styles` on the tile session is the Maps JSON style language,
// and road `labels.icon` is exactly the shields. Road NAMES stay.
const NO_ROAD_SHIELDS = [
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];

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
  const open = async (body) => {
    const res = await fetch(`https://tile.googleapis.com/v1/createSession?key=${GOOGLE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, language: 'en-US', region: 'US' }),
    });
    if (!res.ok) throw new Error(`tiles session ${res.status}`);
    return res.json();
  };
  // Styling is the only way to drop Google's baked-in shields, but a session
  // that will not open at all costs the whole basemap — so a rejected style
  // falls back to a plain session (doubled shields, still a map) rather than
  // dropping the rider onto Esri.
  const json = await open({ ...spec, styles: NO_ROAD_SHIELDS })
    .catch(() => open(spec));
  const rec = { session: json.session, expiry: Number(json.expiry) };
  try {
    const c = loadGtCache();
    c[kind] = rec;
    localStorage.setItem(GT_CACHE, JSON.stringify(c));
  } catch { /* cache full — session still usable this page-load */ }
  return styleFromSession(kind, rec);
}

// ---- the basemap's own route shields ----
// We draw shields on the route (RouteShields.jsx) at OUR spacing, on the road
// the rider is actually on. The vector basemaps post their own on every
// numbered road at their own spacing, so the two together read as clutter —
// which is what the owner saw in Streets: "there is the underlying road map
// native icon, ideally I would like those removed."
//
// A vector style has a layer to reach into, so this is exact: hide the symbol
// layers that carry shield artwork and leave road NAMES, place labels and
// everything else alone. Raster basemaps have no such door — Esri's hybrid
// bakes shields into the World_Transportation overlay and Google's tiles bake
// everything into one image (which is why the Google path asks the server not
// to draw them at session time instead; see NO_ROAD_SHIELDS above).
//
// Idempotent and cheap to call again: run it after every style application,
// since setStyle replaces the layer list wholesale.
export function hideNativeRoadShields(map) {
  let layers;
  try { layers = map.getStyle()?.layers ?? []; } catch { return 0; }
  let hidden = 0;
  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;
    // by id (liberty posts `highway-shield`, `highway-shield-us-interstate`)
    // and by artwork, so a style that names its layers differently but draws
    // from a shield sprite is still caught.
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

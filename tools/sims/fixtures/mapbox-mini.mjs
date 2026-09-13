// A satellite-streets-v12-shaped style, small enough to read: mapbox:// URLs
// everywhere (mapbox-gl resolves each kind itself), Mapbox's imagery as
// the bottom raster, Streets v8 source-layers on top, a shield layer, and a
// poi_label symbol layer.
export const MAPBOX_MINI = {
  version: 8,
  name: 'Mapbox Satellite Streets',
  sprite: 'mapbox://sprites/mapbox/satellite-streets-v12',
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  sources: {
    'mapbox-satellite': { type: 'raster', url: 'mapbox://mapbox.satellite', tileSize: 256 },
    composite: { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#000' } },
    { id: 'satellite', type: 'raster', source: 'mapbox-satellite' },
    { id: 'road-simple', type: 'line', source: 'composite', 'source-layer': 'road', paint: { 'line-color': '#fff', 'line-width': 1.5 } },
    // the real style's hairline: 80% grey at 0.8 alpha, casing only from z9
    { id: 'road-primary-case', type: 'line', source: 'composite', 'source-layer': 'road', minzoom: 9, paint: { 'line-color': 'hsla(0, 1%, 10%, 0.7)', 'line-width': 1, 'line-gap-width': 1 } },
    { id: 'road-primary', type: 'line', source: 'composite', 'source-layer': 'road', minzoom: 6, paint: { 'line-color': 'hsla(0, 0%, 80%, 0.8)', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 3, 0.8, 18, 28, 22, 280] } },
    { id: 'road-number-shield', type: 'symbol', source: 'composite', 'source-layer': 'road', layout: { 'icon-image': ['concat', 'us-interstate-', ['get', 'reflen']], 'text-field': ['get', 'ref'] } },
    { id: 'road-exit-shield', type: 'symbol', source: 'composite', 'source-layer': 'motorway_junction', layout: { 'icon-image': 'motorway-exit-2', 'text-field': ['get', 'ref'] } },
    { id: 'road-label', type: 'symbol', source: 'composite', 'source-layer': 'road', layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line' } },
    { id: 'poi-label', type: 'symbol', source: 'composite', 'source-layer': 'poi_label', layout: { 'text-field': ['get', 'name'], 'icon-image': ['get', 'maki'] } },
    { id: 'natural-point-label', type: 'symbol', source: 'composite', 'source-layer': 'natural_label', layout: { 'text-field': ['get', 'name'], 'icon-image': ['get', 'maki'] } },
    { id: 'continent-label', type: 'symbol', source: 'composite', 'source-layer': 'natural_label', layout: { 'text-field': ['get', 'name'] } },
    { id: 'settlement-label', type: 'symbol', source: 'composite', 'source-layer': 'place_label', layout: { 'text-field': ['get', 'name'] } },
  ],
};

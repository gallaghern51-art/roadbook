// A satellite-streets-v12-shaped style, small enough to read: mapbox:// URLs
// everywhere (mapbox-gl resolves each kind itself), Mapbox's imagery as
// the bottom raster, Streets v8 source-layers on top, a shield layer, and a
// poi_label symbol layer.
export const MAPBOX_MINI = {
  version: 8,
  name: 'Mapbox Satellite Streets (mini)',
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
    { id: 'road-number-shield', type: 'symbol', source: 'composite', 'source-layer': 'road', layout: { 'icon-image': ['concat', 'us-interstate-', ['get', 'reflen']], 'text-field': ['get', 'ref'] } },
    { id: 'road-exit-shield', type: 'symbol', source: 'composite', 'source-layer': 'motorway_junction', layout: { 'icon-image': 'motorway-exit-2', 'text-field': ['get', 'ref'] } },
    { id: 'road-label', type: 'symbol', source: 'composite', 'source-layer': 'road', layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line' } },
    { id: 'poi-label', type: 'symbol', source: 'composite', 'source-layer': 'poi_label', layout: { 'text-field': ['get', 'name'], 'icon-image': ['get', 'maki'] } },
    { id: 'settlement-label', type: 'symbol', source: 'composite', 'source-layer': 'place_label', layout: { 'text-field': ['get', 'name'] } },
  ],
};

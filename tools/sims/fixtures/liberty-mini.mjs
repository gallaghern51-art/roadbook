// A liberty-shaped style, small enough to read: the source-layers and layer
// kinds the composite has to sort — keep roads / road names / places / POIs,
// drop landuse / water / buildings / relief. Tiles point at localhost so a
// sim's route handler can answer (or abort) them.
export const LIBERTY_MINI = {
  version: 8,
  name: 'OSM Liberty (mini)',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    openmaptiles: { type: 'vector', tiles: ['http://localhost:5199/__mock_tiles/{z}/{x}/{y}.pbf'], maxzoom: 14 },
    natural_earth_shaded_relief: { type: 'raster', tiles: ['http://localhost:5199/__mock_relief/{z}/{x}/{y}.png'], tileSize: 256 },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    { id: 'natural_earth', type: 'raster', source: 'natural_earth_shaded_relief' },
    { id: 'landuse_residential', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', paint: { 'fill-color': '#eee' } },
    { id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park', paint: { 'fill-color': '#d8e8c8' } },
    { id: 'park_outline', type: 'line', source: 'openmaptiles', 'source-layer': 'park', paint: { 'line-color': '#9c9' } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': '#bde' } },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', paint: { 'fill-color': '#ddd' } },
    { id: 'highway_motorway_casing', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['==', 'class', 'motorway'], paint: { 'line-color': '#e9ac77', 'line-width': 6 } },
    { id: 'highway_motorway_inner', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['==', 'class', 'motorway'], paint: { 'line-color': '#fc8', 'line-width': 4, 'line-opacity': 1 } },
    { id: 'highway_minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', paint: { 'line-color': '#fff', 'line-width': 2 } },
    { id: 'highway-shield-us-interstate', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', layout: { 'icon-image': 'us-interstate_{ref_length}', 'text-field': '{ref}' }, paint: { 'text-color': '#fff' } },
    { id: 'highway_name_other', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name', layout: { 'text-field': '{name}', 'symbol-placement': 'line' }, paint: { 'text-color': '#333', 'text-halo-color': '#fff' } },
    { id: 'park_label', type: 'symbol', source: 'openmaptiles', 'source-layer': 'park', layout: { 'text-field': '{name}' }, paint: { 'text-color': '#4a6' } },
    { id: 'poi_z16', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 16, layout: { 'text-field': '{name}', 'text-anchor': 'top' }, paint: { 'text-color': '#666', 'text-halo-color': '#fff' } },
    { id: 'poi_z14', type: 'symbol', source: 'openmaptiles', 'source-layer': 'poi', minzoom: 14, filter: ['<=', 'rank', 5], layout: { 'text-field': '{name}' }, paint: { 'text-color': '#666' } },
    { id: 'place_town', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', filter: ['==', 'class', 'town'], layout: { 'text-field': '{name}' }, paint: { 'text-color': '#333', 'text-halo-color': '#fff' } },
    { id: 'place_city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', filter: ['==', 'class', 'city'], layout: { 'text-field': '{name}' }, paint: { 'text-color': '#333' } },
    { id: 'water_name', type: 'symbol', source: 'openmaptiles', 'source-layer': 'water_name', layout: { 'text-field': '{name}' }, paint: { 'text-color': '#358' } },
  ],
};

import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { ROUTE_BLUE } from '../engine/basemaps.js';

// The candidate roads, drawn to be chosen between — Google's grammar, on a
// map that until now carried no route of ours at all.
//
// The selected road is a cased blue line; the others are a muted grey that
// reads as "available, not chosen" over both imagery and a light basemap, and
// each of those is TAPPABLE: a wide invisible hit line rides under every
// option, because a 4px road is not a target on a phone and a rider comparing
// two lines will aim at the line, not at the row in the sheet.
//
// Each option also wears a time bubble at the point where it is furthest from
// every other option — the spot where the choice is actually visible, which is
// where Google puts its own. A bubble at the midpoint of two roads that share
// their first hundred miles would sit on top of the other bubble and label the
// wrong road.
//
//   options   routeOptions() rows — { id, geometry, minutes, miles, label }
//   selected  option id
//   onSelect(id)
//   fitAt     bump this to frame every option, clear of the sheet
//   padBottom how much of the screen the sheet covers

const SRC = 'route-options';
const HIT = 'route-options-hit';

// Where does this option stop agreeing with the others? Walk its vertices and
// take the one whose nearest point on any sibling is furthest away.
function divergencePoint(geometry, siblings) {
  if (!geometry?.length) return null;
  if (!siblings.length) return geometry[Math.floor(geometry.length / 2)];
  const step = Math.max(1, Math.floor(geometry.length / 120)); // a sample, not every vertex
  let best = geometry[Math.floor(geometry.length / 2)];
  let bestGap = -1;
  for (let i = 0; i < geometry.length; i += step) {
    const [lng, lat] = geometry[i];
    let nearest = Infinity;
    for (const sib of siblings) {
      const sstep = Math.max(1, Math.floor(sib.length / 120));
      for (let j = 0; j < sib.length; j += sstep) {
        const d = (sib[j][0] - lng) ** 2 + (sib[j][1] - lat) ** 2;
        if (d < nearest) nearest = d;
        if (nearest === 0) break;
      }
    }
    if (nearest > bestGap) { bestGap = nearest; best = geometry[i]; }
  }
  return best;
}

const fc = (options, selected) => ({
  type: 'FeatureCollection',
  features: (options ?? []).map((o) => ({
    type: 'Feature',
    properties: { id: o.id, chosen: o.id === selected ? 1 : 0 },
    geometry: { type: 'LineString', coordinates: o.geometry ?? [] },
  })),
});

export default function RouteOptionLines({
  map, options = [], selected = null, onSelect, fitAt = 0, padBottom = 0, padTop = 200,
}) {
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const bubbles = useRef(new Map());

  // ---- source + layers ----
  useEffect(() => {
    if (!map) return undefined;
    const add = () => {
      if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: fc(options, selected) });
      // the unchosen roads sit UNDER the chosen one, so the pick always reads on top
      if (!map.getLayer(`${SRC}-alt-case`)) {
        map.addLayer({
          id: `${SRC}-alt-case`,
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'chosen'], 0],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#11151c', 'line-opacity': 0.5, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 12, 9] },
        });
      }
      if (!map.getLayer(`${SRC}-alt`)) {
        map.addLayer({
          id: `${SRC}-alt`,
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'chosen'], 0],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#c3ccd8', 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 12, 5] },
        });
      }
      if (!map.getLayer(`${SRC}-case`)) {
        map.addLayer({
          id: `${SRC}-case`,
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'chosen'], 1],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 7, 12, 12] },
        });
      }
      if (!map.getLayer(`${SRC}-line`)) {
        map.addLayer({
          id: `${SRC}-line`,
          type: 'line',
          source: SRC,
          filter: ['==', ['get', 'chosen'], 1],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ROUTE_BLUE, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 7.5] },
        });
      }
      // the hit line: invisible, wide, and on top of everything so a tap
      // anywhere near an option picks it
      if (!map.getLayer(HIT)) {
        map.addLayer({
          id: HIT,
          type: 'line',
          source: SRC,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#000', 'line-opacity': 0.01, 'line-width': 26 },
        });
      }
    };
    // Every call below is guarded against a map that is being torn down.
    // Home unmounts while mapbox-gl is removing itself (Go → Ride Mode), and
    // a layer call landing in that window throws from deep inside the
    // renderer — `getOwnLayer` / `applyProjectionUpdate` on a style that no
    // longer exists. Caught here, that teardown is silent and harmless.
    const alive = () => {
      try { return !!map.getStyle(); } catch { return false; }
    };
    const guard = (fn) => () => { try { if (alive()) fn(); } catch { /* the map went away mid-frame */ } };
    const addSafe = guard(add);
    if (map.isStyleLoaded()) addSafe(); else map.once('idle', addSafe);
    // a basemap switch replaces the layer list — put them back
    const restyle = guard(() => { if (map.isStyleLoaded()) add(); });
    map.on('styledata', restyle);

    const tap = (e) => {
      const f = e.features?.[0];
      if (!f) return;
      e.originalEvent._wpHandled = true; // never also a POI tap or a drop
      selectRef.current?.(f.properties.id);
    };
    const enter = () => { map.getCanvas().style.cursor = 'pointer'; };
    const leave = () => { map.getCanvas().style.cursor = ''; };
    map.on('click', HIT, tap);
    map.on('mouseenter', HIT, enter);
    map.on('mouseleave', HIT, leave);

    return () => {
      try {
        map.off('styledata', restyle);
        map.off('click', HIT, tap);
        map.off('mouseenter', HIT, enter);
        map.off('mouseleave', HIT, leave);
        if (!alive()) return;
        for (const id of [HIT, `${SRC}-line`, `${SRC}-case`, `${SRC}-alt`, `${SRC}-alt-case`]) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch { /* the map is already gone — nothing to clean up */ }
    };
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- data ----
  useEffect(() => {
    if (!map) return;
    const put = () => { try { map.getSource(SRC)?.setData(fc(options, selected)); } catch { /* torn down */ } };
    let has = false;
    try { has = !!map.getSource(SRC); } catch { has = false; }
    if (has) put(); else map.once('idle', put);
  }, [map, options, selected]);

  // ---- the time bubbles ----
  useEffect(() => {
    if (!map) return undefined;
    const live = new Set();
    (options ?? []).forEach((o) => {
      const at = divergencePoint(o.geometry, options.filter((x) => x !== o).map((x) => x.geometry ?? []));
      if (!at) return;
      live.add(o.id);
      let m = bubbles.current.get(o.id);
      if (!m) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'ro-bubble';
        el.addEventListener('click', (ev) => { ev.stopPropagation(); selectRef.current?.(o.id); });
        m = new mapboxgl.Marker({ element: el, anchor: 'bottom' });
        bubbles.current.set(o.id, m);
      }
      const el = m.getElement();
      el.classList.toggle('chosen', o.id === selected);
      const h = Math.floor(o.minutes / 60);
      const mm = Math.round(o.minutes % 60);
      el.textContent = h ? `${h}h ${mm}m` : `${mm} min`;
      el.setAttribute('aria-label', `${o.label}: ${el.textContent}`);
      m.setLngLat(at);
      if (!el.isConnected) m.addTo(map);
    });
    for (const [id, m] of bubbles.current) {
      if (!live.has(id)) { m.remove(); bubbles.current.delete(id); }
    }
    return undefined;
  }, [map, options, selected]);

  useEffect(() => () => {
    for (const [, m] of bubbles.current) m.remove();
    bubbles.current.clear();
  }, []);

  // ---- frame them ----
  useEffect(() => {
    if (!map || !fitAt || !options?.length) return;
    try {
      const b = new mapboxgl.LngLatBounds();
      for (const o of options) for (const c of o.geometry ?? []) b.extend(c);
      if (b.isEmpty()) return;
      map.fitBounds(b, { padding: { top: padTop, bottom: padBottom + 24, left: 36, right: 36 }, duration: 700 });
    } catch { /* torn down mid-fit */ }
  }, [fitAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}

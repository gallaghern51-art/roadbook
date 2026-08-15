import React, { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { useTrip } from '../engine/store.js';
import { PHASES } from '../data/seedTrip.js';
import { haversineMiles, bestInsertIndex } from '../engine/tripEngine.js';
import { dayTimeline, fmtTime, fmtDur } from '../engine/timeline.js';
import { BASEMAPS, STYLE_SATELLITE, STYLE_FALLBACK, LIGHT_SAFE, ensureTerrain, GOOGLE_KEY, cachedGoogleStyle, googleStyle } from '../engine/basemaps.js';
import { routeDayRoads } from '../engine/routing.js';
import { shieldPlacements } from '../engine/routeShields.js';
import RouteShields from './RouteShields.jsx';
import { useT, useTT, useUnits } from '../engine/settings.jsx';

// Basemap roster: Google tiles headline when a session exists, free styles otherwise.
function buildBasemapList() {
  const hyb = cachedGoogleStyle('hybrid');
  const road = cachedGoogleStyle('roadmap');
  if (!hyb) return { ...BASEMAPS };
  return {
    gsat: { label: 'Satellite', style: hyb },
    ...(road ? { groad: { label: 'Road', style: road } } : {}),
    streets: BASEMAPS.streets,
    dark: BASEMAPS.dark,
    light: BASEMAPS.light,
  };
}

const isTouch = () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

// White chevron with a dark keyline — reads on any basemap and any phase color.
// Points +x: symbol-placement:line rotates it along the route's direction.
function arrowImage(size = 26) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const chevron = () => {
    g.beginPath();
    g.moveTo(size * 0.32, size * 0.2);
    g.lineTo(size * 0.72, size * 0.5);
    g.lineTo(size * 0.32, size * 0.8);
    g.stroke();
  };
  g.strokeStyle = 'rgba(10, 12, 16, 0.9)';
  g.lineWidth = 7;
  chevron();
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3.2;
  chevron();
  return g.getImageData(0, 0, size, size);
}

// Route widths scale with zoom like Google's — thin at trip scale, bold when editing.
const lineWidth = (base) => ['interpolate', ['linear'], ['zoom'], 5, base * 0.75, 9, base, 13, base * 1.9];

export default function MapView() {
  const { state, dispatch, routes, routedLegsByDay } = useTrip();
  const { trip, selectedDayId } = state;
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const labelsRef = useRef([]); // {el, priority, order} for screen-space label culling
  const readyRef = useRef(false);
  const hoverPopupRef = useRef(null);
  const routedRef = useRef(routedLegsByDay);
  routedRef.current = routedLegsByDay;
  const [maps, setMaps] = React.useState(buildBasemapList);
  const [basemap, setBasemap] = React.useState(() => (cachedGoogleStyle('hybrid') ? 'gsat' : 'sat'));
  const basemapRef = useRef(basemap);
  basemapRef.current = basemap;
  const [mapObj, setMapObj] = React.useState(null); // the loaded map, for marker children
  const [dayRoads, setDayRoads] = React.useState(null); // OSRM refs for the selected day
  const [terrain3d, setTerrain3d] = React.useState(false);
  const [switchOpen, setSwitchOpen] = React.useState(false); // basemap row collapsed to a layers pill
  const terrainRef = useRef(false);
  terrainRef.current = terrain3d;
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  const scaleRef = useRef(null);
  const stateRef = useRef({ trip, selectedDayId });
  stateRef.current = { trip, selectedDayId };

  const phaseColor = (phase) => {
    if (basemapRef.current === 'light' && LIGHT_SAFE[phase]) return LIGHT_SAFE[phase];
    return PHASES[phase]?.color ?? '#999';
  };

  // Event handlers registered at init would otherwise capture the first render's
  // drawAll (empty routes) — route everything through a ref to the latest one.
  const drawAllRef = useRef(() => {});
  const cullLabelsRef = useRef(() => {});
  useEffect(() => { drawAllRef.current = drawAll; cullLabelsRef.current = cullLabels; });
  const scheduleDraw = () => {
    const map = mapRef.current;
    if (!map) return;
    if (map.isStyleLoaded()) drawAllRef.current();
    else map.once('idle', () => drawAllRef.current());
  };

  // init once
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: cachedGoogleStyle('hybrid') ?? STYLE_SATELLITE,
      center: [-108.5, 45.9],
      zoom: 5.4,
      // No credit pill on the map at all. Esri and OpenMapTiles require the
      // attribution to be *displayed*, not to be displayed on the map surface —
      // so it moves to Settings, where it is one tap away and permanent, and
      // the map keeps its corner. See CREDITS in SettingsModal.
      attributionControl: false,
    });
    mapRef.current = map;
    if (import.meta.env.DEV) window.__map = map; // console access while developing
    // On touch, pinch-zoom replaces the +/− control and the screen is too
    // small to spend on it.
    if (!isTouch()) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }), 'top-right');
    const scale = new maplibregl.ScaleControl({ unit: 'imperial' });
    map.addControl(scale, 'bottom-right');
    scaleRef.current = scale;
    // labels are DOM markers with no collision engine — hide them when the
    // camera is too far out for a day's 15 names to be anything but noise
    // `move` keeps labels sane during the gesture; the *end events re-run on the
    // settled camera, because a mid-flight cull can leave a pair overlapping.
    map.on('move', () => cullLabelsRef.current());
    map.on('moveend', () => cullLabelsRef.current());
    map.on('zoomend', () => cullLabelsRef.current());
    // Direction chevrons live in the style's image store, which setStyle wipes.
    const addArrow = () => { if (!map.hasImage('route-arrow')) map.addImage('route-arrow', arrowImage()); };
    map.on('styleimagemissing', (e) => { if (e.id === 'route-arrow') addArrow(); });
    let fellBack = false;
    map.on('error', (e) => {
      if (!fellBack && String(e?.error?.message || '').match(/style|404|403/i)) {
        fellBack = true;
        map.setStyle(STYLE_FALLBACK);
      }
    });
    map.on('load', () => {
      readyRef.current = true;
      setMapObj(map); // shield markers mount against a loaded map
      drawAllRef.current();
    });
    map.on('styledata', () => {
      if (readyRef.current) scheduleDraw();
    });
    hoverPopupRef.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: '280px' });
    // click empty map = add waypoint to the selected day
    map.on('click', (e) => {
      const { selectedDayId: dayId } = stateRef.current;
      if (!dayId) return;
      if (e.originalEvent._wpHandled) return;
      // clicking a route line opens the leg modal, not the add-stop prompt
      const lineIds = stateRef.current.trip.days
        .map((d) => `route-${d.id}-line`)
        .filter((id) => map.getLayer(id));
      if (map.queryRenderedFeatures(e.point, { layers: lineIds }).length) return;
      const name = window.prompt(t('Add a stop here — name it:'));
      if (!name) return;
      const day = stateRef.current.trip.days.find((d) => d.id === dayId);
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      dispatch({
        type: 'apply_ops',
        ops: [{ op: 'add_waypoint', dayId, index: bestInsertIndex(day.waypoints, pt), waypoint: { name, ...pt, kind: 'via' } }],
      });
    });
    // The map is a hidden tab on mobile; maplibre only watches the window, so
    // watch the container and re-measure whenever it comes back on screen.
    const ro = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) map.resize();
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); setMapObj(null); map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- highway shields along the day you are editing ----
  // Only the selected day: at whole-trip zoom eleven days of shields is the
  // picket fence routeShields.js exists to avoid, and the road numbers are
  // not what you are reading at that scale anyway.
  //
  // The refs come from a separate OSRM fetch (routeDayRoads) rather than from
  // routeDaySteps — that one tries Google first, which is billable per day and
  // carries no ref field to begin with.
  useEffect(() => {
    if (!selectedDayId) { setDayRoads(null); return undefined; }
    const day = trip.days.find((d) => d.id === selectedDayId);
    if (!day) { setDayRoads(null); return undefined; }
    let dead = false;
    setDayRoads(null);
    routeDayRoads(day)
      .then((r) => { if (!dead) setDayRoads(r); })
      .catch(() => { if (!dead) setDayRoads([]); });
    return () => { dead = true; };
  }, [selectedDayId, trip.days]);

  const shieldMarks = React.useMemo(() => {
    if (!selectedDayId || !dayRoads?.length) return [];
    const geom = routes[selectedDayId]?.geometry;
    if (!geom || routes[selectedDayId]?.fallback || geom.length < 2) return [];
    return shieldPlacements(dayRoads, geom.map(([lng, lat]) => ({ lat, lng })));
  }, [selectedDayId, dayRoads, routes]);

  // the day's stops, so a shield never lands on one
  const shieldAvoid = React.useMemo(
    () => trip.days.find((d) => d.id === selectedDayId)?.waypoints ?? [],
    [trip.days, selectedDayId]
  );

  // the map scale bar follows the units setting
  useEffect(() => {
    scaleRef.current?.setUnit(u.metric ? 'metric' : 'imperial');
  }, [u.metric]);

  // redraw on data change
  useEffect(() => {
    if (readyRef.current) drawAll();
  }, [trip, selectedDayId, routes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Google tile sessions arrive async — swap the roster in and lead with Google
  // satellite unless the user already picked something else.
  useEffect(() => {
    if (!GOOGLE_KEY) return;
    let dead = false;
    (async () => {
      try {
        const [hyb, road] = await Promise.all([googleStyle('hybrid'), googleStyle('roadmap')]);
        if (dead || !hyb) return;
        setMaps({
          gsat: { label: 'Satellite', style: hyb },
          ...(road ? { groad: { label: 'Road', style: road } } : {}),
          streets: BASEMAPS.streets,
          dark: BASEMAPS.dark,
          light: BASEMAPS.light,
        });
        setBasemap((b) => (b === 'sat' ? 'gsat' : b));
      } catch { /* Map Tiles API unavailable — free basemaps carry on */ }
    })();
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // basemap switch — setStyle wipes sources; redraw once the new style has loaded
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setStyle(maps[basemap]?.style ?? STYLE_FALLBACK);
    map.once('idle', () => drawAllRef.current());
  }, [basemap]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3D toggle — terrain + a tilted camera (drawAll re-asserts it after style switches)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const apply = () => {
      ensureTerrain(map, terrain3d);
      map.easeTo({ pitch: terrain3d ? 55 : 0, duration: 800 });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('idle', apply);
  }, [terrain3d]);

  // fly to a stop the user tapped in the day panel
  useEffect(() => {
    const map = mapRef.current;
    const f = state.focus;
    if (!map || !f) return;
    map.flyTo({ center: [f.lng, f.lat], zoom: Math.max(map.getZoom(), 13.8), duration: 900 });
  }, [state.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // fit bounds when selection changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const days = selectedDayId ? trip.days.filter((d) => d.id === selectedDayId) : trip.days;
    const pts = days.flatMap((d) => d.waypoints.map((w) => [w.lng, w.lat]));
    if (!pts.length) return;
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const doFit = () => {
      // A phone-width map has no room for desk-sized gutters.
      const padding = map.getContainer().clientWidth < 560 ? 28 : 70;
      map.fitBounds(b, { padding, duration: 700, maxZoom: 10.5 });
    };
    // At first paint the container can still be zero-sized — fitBounds refuses
    // ("cannot fit within canvas"); retry once layout has settled.
    if ((map.getContainer().clientWidth || 0) < 100) {
      const t = setTimeout(doFit, 350);
      return () => clearTimeout(t);
    }
    doFit();
  }, [selectedDayId, trip.days.length]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawAll() {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const { trip: t, selectedDayId: sel } = stateRef.current;
    ensureTerrain(map, terrainRef.current);
    if (!map.hasImage('route-arrow')) map.addImage('route-arrow', arrowImage());

    for (const day of t.days) {
      const geom = routes[day.id]?.geometry ?? day.waypoints.map((w) => [w.lng, w.lat]);
      const active = sel === null || sel === day.id;
      const color = phaseColor(day.phase);
      const srcId = `route-${day.id}`;
      const data = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: geom },
      };
      if (map.getSource(srcId)) {
        map.getSource(srcId).setData(data);
      } else {
        map.addSource(srcId, { type: 'geojson', data });
        const round = { 'line-cap': 'round', 'line-join': 'round' };
        map.addLayer({
          id: `${srcId}-glow`, type: 'line', source: srcId,
          paint: { 'line-color': color, 'line-width': lineWidth(8), 'line-opacity': 0.18, 'line-blur': 4 },
          layout: round,
        });
        map.addLayer({
          id: `${srcId}-casing`, type: 'line', source: srcId,
          paint: { 'line-color': '#000000', 'line-width': lineWidth(5.5), 'line-opacity': 0.7 },
          layout: round,
        });
        map.addLayer({
          id: `${srcId}-line`, type: 'line', source: srcId,
          paint: { 'line-color': color, 'line-width': lineWidth(3), 'line-opacity': 0.9 },
          layout: round,
        });
        map.addLayer({
          id: `${srcId}-arrows`, type: 'symbol', source: srcId,
          layout: {
            'symbol-placement': 'line', 'symbol-spacing': 130,
            'icon-image': 'route-arrow', 'icon-size': 0.72,
            'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
          },
          paint: { 'icon-opacity': 0.9 },
        });
        wireLegEvents(map, day.id, `${srcId}-line`);
      }
      const lineOpacity = active ? 0.95 : 0.25;
      map.setPaintProperty(`${srcId}-line`, 'line-color', color);
      map.setPaintProperty(`${srcId}-glow`, 'line-color', color);
      map.setPaintProperty(`${srcId}-line`, 'line-opacity', lineOpacity);
      map.setPaintProperty(`${srcId}-line`, 'line-width', lineWidth(sel === day.id ? 4.5 : 3));
      map.setPaintProperty(`${srcId}-casing`, 'line-width', lineWidth(sel === day.id ? 7 : 5.5));
      map.setPaintProperty(`${srcId}-casing`, 'line-opacity', active ? 0.7 : 0.12);
      map.setPaintProperty(`${srcId}-glow`, 'line-opacity', active ? 0.2 : 0.05);
      map.setPaintProperty(`${srcId}-arrows`, 'icon-opacity', active ? 0.9 : 0);
    }
    // The leg-highlight layer rides on top of every route: hovering a stop row
    // in the day panel lights the stretch of road that leg actually covers.
    if (!map.getSource('leg-hi')) {
      map.addSource('leg-hi', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } });
      const round = { 'line-cap': 'round', 'line-join': 'round' };
      map.addLayer({
        id: 'leg-hi-glow', type: 'line', source: 'leg-hi',
        paint: { 'line-color': '#ffffff', 'line-width': lineWidth(11), 'line-opacity': 0.3, 'line-blur': 6 },
        layout: round,
      });
      map.addLayer({
        id: 'leg-hi-line', type: 'line', source: 'leg-hi',
        paint: { 'line-color': '#ffffff', 'line-width': lineWidth(4.5), 'line-opacity': 0.95 },
        layout: round,
      });
    }
    // prune sources for deleted days
    drawMarkers();
  }

  // Hovered leg → the slice of routed geometry between its two waypoints.
  const legZoomAtRef = useRef(0);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getSource('leg-hi')) return;
    const fl = state.focusLeg;
    let coords = [];
    if (fl) {
      const day = state.trip.days.find((d) => d.id === fl.dayId);
      const a = day?.waypoints[fl.index];
      const b = day?.waypoints[fl.index + 1];
      if (a && b) {
        const geom = routes[fl.dayId]?.geometry;
        if (geom?.length > 1) {
          const near = (wp) => {
            let best = 0;
            let bd = Infinity;
            for (let i = 0; i < geom.length; i++) {
              const dx = geom[i][0] - wp.lng;
              const dy = geom[i][1] - wp.lat;
              const d = dx * dx + dy * dy;
              if (d < bd) { bd = d; best = i; }
            }
            return best;
          };
          let ia = near(a);
          let ib = near(b);
          if (ia > ib) [ia, ib] = [ib, ia];
          coords = geom.slice(ia, ib + 1);
        }
        if (coords.length < 2) coords = [[a.lng, a.lat], [b.lng, b.lat]];
      }
    }
    map.getSource('leg-hi').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
    // A zoom-tagged focus (a TAP, not a hover) frames the leg — once per tap,
    // so a routes refresh doesn't re-yank the camera.
    if (fl?.zoom && fl.zoom !== legZoomAtRef.current && coords.length > 1) {
      legZoomAtRef.current = fl.zoom;
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: { top: 150, bottom: 90, left: 50, right: 50 }, maxZoom: 13, duration: 700 });
    }
  }, [state.focusLeg, routes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Which leg of a day is nearest to a clicked/hovered point.
  function nearestLegIndex(day, pt) {
    let best = 0;
    let bestCost = Infinity;
    for (let i = 0; i < day.waypoints.length - 1; i++) {
      const a = day.waypoints[i];
      const b = day.waypoints[i + 1];
      const cost = haversineMiles(a, pt) + haversineMiles(pt, b) - haversineMiles(a, b);
      if (cost < bestCost) { bestCost = cost; best = i; }
    }
    return best;
  }

  const wiredLayers = useRef(new Set());
  function wireLegEvents(map, dayId, layerId) {
    if (wiredLayers.current.has(layerId)) return;
    wiredLayers.current.add(layerId);
    map.on('mousemove', layerId, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const day = stateRef.current.trip.days.find((d) => d.id === dayId);
      if (!day) return;
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const li = nearestLegIndex(day, pt);
      const tl = dayTimeline(day, routedRef.current?.[dayId]);
      const from = day.waypoints[li];
      const to = day.waypoints[li + 1];
      const seg = tl.stops[li + 1];
      hoverPopupRef.current
        .setLngLat(e.lngLat)
        .setHTML(`
          <div class="pp-name">${esc(day.dow)} · ${esc(shortLeg(from?.name))} → ${esc(shortLeg(to?.name))}</div>
          <div class="pp-note">${seg ? `${u.mi(seg.legMiles)} · ${fmtDur(seg.legMin)} · ETA ${fmtTime(seg.arrive)}` : ''}</div>
          <div class="pp-note">Click for leg details</div>`)
        .addTo(map);
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
      hoverPopupRef.current?.remove();
    });
    map.on('click', layerId, (e) => {
      e.originalEvent._wpHandled = true;
      const day = stateRef.current.trip.days.find((d) => d.id === dayId);
      if (!day) return;
      const li = nearestLegIndex(day, { lat: e.lngLat.lat, lng: e.lngLat.lng });
      hoverPopupRef.current?.remove();
      dispatch({ type: 'open_modal', modal: { type: 'leg', dayId, legIndex: li } });
    });
  }

  // MapLibre collides its own symbol labels, but these are DOM markers, so do it
  // here: walk labels by priority and hide any whose box overlaps one already
  // kept. Re-runs on every camera move — what fits at z12 does not fit at z9.
  function cullLabels() {
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const ordered = [...labelsRef.current].sort((a, b) => a.priority - b.priority || a.order - b.order);
    const kept = [];
    // `display`, not `visibility`: visibility is inherited, so setting a label
    // to `visible` here overrode the `visibility: hidden` that parks the whole
    // map pane off-screen on mobile — the stop names floated over the day panel
    // in the next tab. display is not inherited and cannot leak that way.
    for (const { el } of ordered) el.style.display = ''; // measure unhidden
    for (const { el } of ordered) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      // 3px breathing room so kept labels never look kerned together
      const box = { left: r.left - 3, right: r.right + 3, top: r.top - 3, bottom: r.bottom + 3 };
      if (kept.some((k) => overlaps(box, k))) el.style.display = 'none';
      else kept.push(box);
    }
  }

  function drawMarkers() {
    const map = mapRef.current;
    const { trip: t, selectedDayId: sel } = stateRef.current;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    labelsRef.current = [];

    const days = sel ? t.days.filter((d) => d.id === sel) : t.days;
    for (const day of days) {
      const color = phaseColor(day.phase);
      const showAll = sel === day.id;
      for (const [wi, w] of day.waypoints.entries()) {
        // A day's endpoints are POSITIONAL, not a matter of what kind the stop
        // carries: AI-built days default every stop to 'via', which left real
        // overnights (Bozeman on the solo fork) markerless at trip zoom.
        const isEnd = w.kind === 'start' || w.kind === 'end'
          || wi === 0 || wi === day.waypoints.length - 1;
        if (!showAll && !isEnd) continue;
        const el = document.createElement('div');
        el.className = `wp-marker${w.fuel ? ' fuel' : ''}${w.kind === 'photo' ? ' photo' : ''}`;
        el.style.background = w.fuel ? '#f48322' : w.kind === 'photo' ? '#cecece' : color;
        if (isEnd) {
          const size = isTouch() ? '20px' : '16px';
          el.style.width = size;
          el.style.height = size;
        }
        // Name labels while editing a day — the whole-trip view stays clean.
        // Always below the marker, like Apple Maps: the route line runs through
        // the marker's centre, so a label underneath never sits on the line.
        // Label-on-label overlap is resolved by cullLabels().
        if (showAll) {
          const lab = document.createElement('span');
          lab.className = 'wp-label';
          lab.textContent = w.name.length > 26 ? w.name.slice(0, 25) + '…' : w.name;
          el.appendChild(lab);
          // endpoints and fuel stops win a contested spot over a generic via
          const priority = isEnd ? 0 : w.fuel ? 1 : w.kind === 'photo' ? 2 : 3;
          labelsRef.current.push({ el: lab, priority, order: wi });
        }
        const marker = new maplibregl.Marker({ element: el, draggable: showAll })
          .setLngLat([w.lng, w.lat])
          .addTo(map);

        // hover: quick detail tooltip with ETA · click: full stop modal
        el.addEventListener('mouseenter', () => {
          const tl = dayTimeline(day, routedRef.current?.[day.id]);
          const s = tl.stops.find((x) => x.id === w.id);
          hoverPopupRef.current
            .setLngLat([w.lng, w.lat])
            .setHTML(`
              <div class="pp-name">${esc(w.name)}</div>
              <div class="pp-note">${day.dow} · ${s ? `ETA ${fmtTime(s.arrive)}` : ''}${w.fuel ? ' · FUEL' : ''}${w.kind === 'photo' ? ` · ${t('Photo').toUpperCase()}` : ''}</div>
              ${w.note ? `<div class="pp-note">${esc(w.note)}</div>` : ''}
              <div class="pp-note">${t('Click for details')}</div>`)
            .addTo(map);
        });
        el.addEventListener('mouseleave', () => hoverPopupRef.current?.remove());
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev._wpHandled = true;
          hoverPopupRef.current?.remove();
          dispatch({ type: 'open_modal', modal: { type: 'stop', dayId: day.id, waypointId: w.id } });
        });

        if (showAll) {
          marker.on('dragend', () => {
            const ll = marker.getLngLat();
            dispatch({
              type: 'apply_ops',
              // a dragged pin is a deliberate raw coordinate — any old place
              // identity no longer describes where the marker sits
              ops: [{ op: 'update_waypoint', dayId: day.id, waypointId: w.id, patch: { lat: ll.lat, lng: ll.lng, placeId: null } }],
            });
          });
        }
        markersRef.current.push(marker);
      }
    }
    // labels exist in the DOM now — measure and de-conflict them
    requestAnimationFrame(cullLabels);
  }

  const selectedDay = trip.days.find((d) => d.id === selectedDayId);
  return (
    <div className={`map-wrap${['streets', 'light', 'groad'].includes(basemap) ? ' labels-dark' : ''}`}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* Real signage on the line the route line was covering up */}
      <RouteShields map={mapObj} placements={shieldMarks} avoid={shieldAvoid} mode="plan" />
      <div className="map-hint">
        {selectedDay
          ? <>{t('Editing')} <b>{selectedDay.dow} {selectedDay.date.slice(5)}</b><span className="hint-more"> {t('— click map to add a stop · drag markers · click stops & legs for details')}</span></>
          : <>{t('Whole-trip view')}<span className="hint-more"> {t('— hover a route for leg info, click for details, pick a day to edit')}</span></>}
      </div>
      {/* The first minute of a cold load is OSRM routing eleven days one by
          one — without narration it reads as a broken map. Say what the
          engine is doing until every day has road geometry. */}
      {Object.keys(routes).length < trip.days.length && (
        <div className="routing-chip">
          <span className="routing-dot" />
          {t('Routing')} {Math.min(Object.keys(routes).length + 1, trip.days.length)}/{trip.days.length}…
        </div>
      )}
      {/* Collapsed by default: one layers pill naming the current basemap.
          Picking a style closes it again — the row only exists while choosing. */}
      <div className={`basemap-switch${switchOpen ? '' : ' closed'}`}>
        <button
          className="bs-toggle"
          aria-expanded={switchOpen}
          title={t('Basemap')}
          onClick={() => setSwitchOpen((v) => !v)}
        >
          <svg viewBox="0 0 20 20" className="bs-ic" aria-hidden="true">
            <path d="M10 2.5 L17.5 7 L10 11.5 L2.5 7 Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M3.6 10.4 L10 14.2 L16.4 10.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.65" />
            <path d="M3.6 13.6 L10 17.4 L16.4 13.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" />
          </svg>
          {!switchOpen && <span className="bs-cur">{maps[basemap]?.label ?? '…'}{terrain3d ? ' · 3D' : ''}</span>}
        </button>
        {switchOpen && (
          <>
            {Object.entries(maps).map(([key, b]) => (
              <button
                key={key}
                className={basemap === key ? 'active' : ''}
                onClick={() => { setBasemap(key); setSwitchOpen(false); }}
              >{b.label}</button>
            ))}
            <button
              className={terrain3d ? 'active' : ''}
              title="3D terrain"
              onClick={() => setTerrain3d((v) => !v)}
            >3D</button>
          </>
        )}
      </div>
      <div className="map-legend">
        {Object.entries(PHASES).map(([k, p]) => (
          <span key={k} className="key"><i style={{ background: p.color }} />{t(p.label)}</span>
        ))}
        <span className="key"><i style={{ background: '#f48322', height: 8, width: 8, borderRadius: 2 }} />{t('Fuel')}</span>
        <span className="key"><i style={{ background: '#cecece', height: 8, width: 8, borderRadius: 2, transform: 'rotate(45deg)' }} />{t('Photo')}</span>
      </div>
    </div>
  );
}

function shortLeg(name) {
  if (!name) return '?';
  return name.length > 22 ? name.slice(0, 21) + '…' : name;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

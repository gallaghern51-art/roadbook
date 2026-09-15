import React, { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { useTrip } from '../engine/store.js';
import { PHASES } from '../data/seedTrip.js';
import {
  haversineMiles, bestInsertIndex, insertIndexOnRoute, insertIndexAtAlong,
  alongOnRoute, chainCumMiles,
} from '../engine/tripEngine.js';
import { dayTimeline, fmtTime, fmtDur } from '../engine/timeline.js';
import { BASEMAPS, STYLE_FALLBACK, LIGHT_SAFE, STREETS_SAFE, SAT_SAFE, ROUTE_BLUE, MAPBOX_TOKEN, ensureTerrain, hideNativeRoadShields, liftSatelliteRoads, tappableLayerIds, basemapStyle, isStyleLoadError } from '../engine/basemaps.js';
import PoiCard from './PoiCard.jsx';
import StopSheet from './StopSheet.jsx';
import DropPin from './DropPin.jsx';
import { attachLongPress } from '../engine/mapGestures.js';
import { reverseGeocode, coordLabel } from '../engine/places.js';
import { routeDayRoads } from '../engine/routing.js';
import { shieldPlacements } from '../engine/routeShields.js';
import RouteShields from './RouteShields.jsx';
import RouteWheel from './RouteWheel.jsx';
import PlacePins from './PlacePins.jsx';
import { useT, useTT, useUnits } from '../engine/settings.jsx';
import { InputSheet } from './Sheets.jsx';

// Basemap roster: Mapbox's four styles with a token (Satellite is
// satellite-streets — imagery under, vector roads/labels/POIs over, so POIs
// are tappable), Esri imagery alone without one. See basemaps.js.
const maps = BASEMAPS;

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
  const { state, dispatch, routes, routedLegsByDay, ui } = useTrip();
  const { trip, selectedDayId } = state;
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const labelsRef = useRef([]); // {el, priority, order} for screen-space label culling
  const readyRef = useRef(false);
  const hoverPopupRef = useRef(null);
  const routedRef = useRef(routedLegsByDay);
  routedRef.current = routedLegsByDay;
  const routesRef = useRef(routes);
  routesRef.current = routes;
  // A live route-line drag: {dayId, index, from, to, at}. Held in a ref because
  // it is driven by map events, not renders — a setState per mousemove would
  // re-run every effect in this component sixty times a second.
  const dragRef = useRef(null);
  const [dragging, setDragging] = React.useState(false); // for the cursor + hint only
  const [addAt, setAddAt] = React.useState(null); // {dayId, pt, index} awaiting a name
  // Touch's answer to the drag: a wheel anchored where the rider tapped the
  // route, with adjust and confirm as separate acts.
  const [wheel, setWheel] = React.useState(null);
  const wheelRef = useRef(null);
  wheelRef.current = wheel;
  const beginDragRef = useRef(() => {});
  const paintedDragRef = useRef(0); // how many points the drag layer currently holds
  const [basemap, setBasemap] = React.useState('sat');
  const [poi, setPoi] = React.useState(null); // a vector POI tapped on the composite satellite — or a dropped pin (poi.placed)
  const [stopSheet, setStopSheet] = React.useState(null); // {dayId, waypointId}: a stop marker tapped
  const [drop, setDrop] = React.useState(null); // {key, lat, lng, name, detail}: the dropped pin, with its wheel
  const dropStateRef = useRef(null);
  dropStateRef.current = drop;
  const dropRef = useRef(null);
  const geoTimerRef = useRef(null);
  const appliedStyleRef = useRef(null); // the style object the map currently wears
  const poiTapRef = useRef(null);
  const poiHoverRef = useRef(new Set());
  const basemapRef = useRef(basemap);
  basemapRef.current = basemap;
  const [mapObj, setMapObj] = React.useState(null); // the loaded map, for marker children
  const [dayRoads, setDayRoads] = React.useState(null); // OSRM refs for the selected day
  const [terrain3d, setTerrain3d] = React.useState(false);
  const [switchOpen, setSwitchOpen] = React.useState(false); // basemap row collapsed to a layers pill
  const terrainRef = useRef(false);
  terrainRef.current = terrain3d;
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const tt = useTT();
  const u = useUnits();
  const scaleRef = useRef(null);
  const stateRef = useRef({ trip, selectedDayId, routePreview: ui?.routePreview });
  stateRef.current = { trip, selectedDayId, routePreview: ui?.routePreview };

  const phaseColor = (phase) => {
    const bm = basemapRef.current;
    if (bm === 'sat') {
      // a quick ride has no days to tell apart: plain blue, Google-style
      if (stateRef.current.trip?.meta?.quick) return ROUTE_BLUE;
      if (SAT_SAFE[phase]) return SAT_SAFE[phase];
    }
    if (bm === 'light' && LIGHT_SAFE[phase]) return LIGHT_SAFE[phase];
    if (bm === 'streets' && STREETS_SAFE[phase]) return STREETS_SAFE[phase]; // Streets is a light map: its grey phases vanish on white roads too
    return PHASES[phase]?.color ?? '#999';
  };
  // Google's grammar: roads are dark-cased light lines, the ROUTE is a
  // light-cased coloured one — on satellite (where the roads are drawn that
  // way) the casing flips to white so the route is never mistaken for a road
  const routeCasing = () => (basemapRef.current === 'sat' ? '#ffffff' : '#000000');

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
    const map = new mapboxgl.Map({
      container: containerRef.current,
      accessToken: MAPBOX_TOKEN, // per map, so basemaps.js never has to import the renderer (node sims import it)
      style: (appliedStyleRef.current = basemapStyle(basemapRef.current)),
      center: [-108.5, 45.9],
      zoom: 5.4,
      // Mapbox's terms want the wordmark and "© Mapbox © OpenStreetMap" ON the
      // map; the compact ⓘ pill and the small logo are the cost of the tiles.
      // Settings carries the full credits too (CREDITS in SettingsModal).
      // the credit ⓘ goes bottom-left with the wordmark and the scale: the
      // Copilot fab owns the bottom-right corner and was covering it
      attributionControl: false,
    });
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');
    mapRef.current = map;
    if (import.meta.env.DEV) window.__map = map; // console access while developing
    // On touch, pinch-zoom replaces the +/− control and the screen is too
    // small to spend on it.
    if (!isTouch()) map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }), 'top-right');
    const scale = new mapboxgl.ScaleControl({ unit: 'imperial' });
    map.addControl(scale, 'bottom-left');
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
    // a Mapbox style that will not load (token restricted to other URLs,
    // offline before the style cached) lands on Esri imagery, not a blank map
    let fellBack = false;
    map.on('error', (e) => {
      if (fellBack || !isStyleLoadError(e) || map.isStyleLoaded()) return;
      fellBack = true;
      appliedStyleRef.current = STYLE_FALLBACK;
      map.setStyle(STYLE_FALLBACK);
    });
    map.on('load', () => {
      readyRef.current = true;
      setMapObj(map); // shield markers mount against a loaded map
      drawAllRef.current();
    });
    // `styledata` exists here for ONE reason: setStyle (a basemap swap) throws
    // away every source and layer we added, and they have to go back. But the
    // event also fires for ordinary style traffic — and drawAll itself mutates
    // the style (ensureTerrain, hideNativeRoadShields, addImage), so an
    // unconditional redraw here is a feedback loop: drawAll → styledata →
    // drawAll. Measured at 3 styledata/sec, 445 sourcedata/sec and 66 marker
    // rebuilds a second on an idle map — which is the flashing, and the reason
    // a tap could land between a marker being destroyed and re-created.
    //
    // So: redraw only when our own layers are actually GONE. That is exactly
    // the condition this handler was written for, and it is cheap to ask.
    // …and only once the new style is IDLE: mapbox-gl's symbol placement is
    // still running against the fresh style when styledata fires, and adding
    // layers or flipping a shield layer's visibility in that window throws
    // inside its placement pass (an uncaught TypeError in continuePlacement).
    map.on('styledata', () => {
      if (!readyRef.current) return;
      if (map.getLayer('leg-hi-line')) return; // our layers survived — nothing to rebuild
      map.once('idle', () => drawAllRef.current());
    });
    hoverPopupRef.current = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12, maxWidth: '280px' });
    // click empty map = add waypoint to the selected day
    // a long press (touch) or right-click (mouse) on open map drops a pin —
    // a PLACED spot the same card handles; the click that can trail a press
    // is swallowed so it never doubles as a dismiss or a click-to-add
    const press = attachLongPress(map, (pt) => dropRef.current?.(pt));
    if (import.meta.env.DEV) window.__mapPress = (pt) => dropRef.current?.(pt); // sim seam: the handler a real press reaches
    map.on('click', (e) => {
      const { selectedDayId: dayId } = stateRef.current;
      if (e.originalEvent._wpHandled) return;
      if (press.recent()) return;
      if (dragRef.current) return; // the click that ends a drag is not an add
      if (wheelRef.current) { setWheel(null); paintDrag(); return; } // dismiss first
      if (dropStateRef.current) { dropRef.current?.cancel(); return; } // a dropped pin: a tap on open map takes it away
      // a POI symbol under the finger is a place, not a spot on the map —
      // satellite-streets draws them as vector features, so this is a real
      // hit test, the thing a baked raster could never answer
      const poiIds = tappableLayerIds(map);
      if (poiIds.length) {
        const hits = map.queryRenderedFeatures(e.point, { layers: poiIds });
        if (hits.length) { poiTapRef.current?.(hits[0], e.lngLat); return; }
      }
      setPoi(null);
      if (!dayId) return;
      // clicking a route line opens the leg modal, not the add-stop prompt
      const lineIds = stateRef.current.trip.days
        .map((d) => `route-${d.id}-line`)
        .filter((id) => map.getLayer(id));
      if (map.queryRenderedFeatures(e.point, { layers: lineIds }).length) return;
      const day = stateRef.current.trip.days.find((d) => d.id === dayId);
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      // Where it lands in the DAY'S ORDER is read off the routed line, not off
      // straight lines between stops: the road is what the rider is looking at.
      setAddAt({ dayId, pt, index: routeAwareIndex(day, pt) });
    });

    // ---- drag the route line to pull it onto the road you wanted ----
    // Google's grammar: grab the line, drop it somewhere, and the route is
    // re-planned through that point. Here the drop becomes a real `via`
    // waypoint (Valhalla routes intermediate stops as break_through, so the
    // line actually goes there) inserted at the slot the GRAB identifies.
    const moveDrag = (e) => {
      const d = dragRef.current;
      if (!d) return;
      d.at = [e.lngLat.lng, e.lngLat.lat];
      paintDrag();
    };
    const endDrag = (e) => {
      const d = dragRef.current;
      if (!d) return;
      map.dragPan.enable();
      map.getCanvas().style.cursor = '';
      map.off('mousemove', moveDrag);
      const at = e?.lngLat ? [e.lngLat.lng, e.lngLat.lat] : d.at;
      // A drag that never left the line is a click — the rider was reading the
      // leg, not moving it. Let the layer's click handler have it.
      const moved = at && Math.hypot(
        (at[0] - d.from[0]) * Math.cos((d.from[1] * Math.PI) / 180), at[1] - d.from[1],
      ) > 0.0008;
      dragRef.current = null;
      setDragging(false);
      paintDrag();
      if (!moved || !at) return;
      if (e?.originalEvent) e.originalEvent._wpHandled = true;
      const day = stateRef.current.trip.days.find((x) => x.id === d.dayId);
      if (!day) return;
      const vias = day.waypoints.filter((w) => w.kind === 'via').length;
      dispatch({
        type: 'apply_ops',
        ops: [{
          op: 'add_waypoint',
          dayId: d.dayId,
          index: d.index,
          waypoint: { name: `${tRef.current('Via')} ${vias + 1}`, lat: at[1], lng: at[0], kind: 'via' },
        }],
      });
    };
    beginDragRef.current = (dayId, e) => {
      if (dragRef.current) return; // the glow and the line both match one press
      const day = stateRef.current.trip.days.find((x) => x.id === dayId);
      if (!day || day.waypoints.length < 2) return;
      const grab = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const index = routeAwareIndex(day, grab, { grabbedOnLine: true });
      if (index == null) return;
      e.preventDefault?.();
      map.dragPan.disable();
      map.getCanvas().style.cursor = 'grabbing';
      hoverPopupRef.current?.remove();
      dragRef.current = {
        dayId,
        index,
        from: [grab.lng, grab.lat],
        at: [grab.lng, grab.lat],
        // The stops either side of the grab — the rubber band runs between
        // them so the rider sees which stretch they are moving.
        a: day.waypoints[index - 1],
        b: day.waypoints[index],
      };
      setDragging(true);
      paintDrag();
      map.on('mousemove', moveDrag);
      map.once('mouseup', endDrag);
    };
    map.on('mouseout', () => { if (dragRef.current) endDrag(null); });
    // The map is a hidden tab on mobile; mapbox-gl only watches the window, so
    // watch the container and re-measure whenever it comes back on screen.
    const ro = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) map.resize();
    });
    ro.observe(containerRef.current);
    return () => { ro.disconnect(); press.detach(); setMapObj(null); map.remove(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- highway shields along the day you are editing ----
  // Only the selected day: at whole-trip zoom eleven days of shields is the
  // picket fence routeShields.js exists to avoid, and the road numbers are
  // not what you are reading at that scale anyway.
  //
  // The refs come from a separate OSRM fetch (routeDayRoads) rather than from
  // routeDaySteps — its Valhalla output has no route-ref field and its Google
  // outage fallback is billable, while this small OSRM fetch is static.
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
    if (!readyRef.current) return undefined;
    drawAll();
    // MapLibre applies GeoJSON source changes on its render worker. Reassert
    // the overlay on the next frame so a preview opened in an otherwise-idle
    // dark map does not wait for some unrelated UI change before appearing.
    const frame = requestAnimationFrame(() => drawAllRef.current());
    return () => cancelAnimationFrame(frame);
  }, [trip, selectedDayId, routes, ui?.routePreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // basemap switch — setStyle wipes sources; redraw once the new style has loaded
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const style = basemapStyle(basemap);
    // the constructor's style is recorded so the first load never swaps a
    // style for itself; a fallback that replaced it re-applies on the next pick
    const apply = () => {
      if (appliedStyleRef.current === style) return;
      appliedStyleRef.current = style;
      map.setStyle(style);
      map.once('idle', () => drawAllRef.current());
    };
    if (!readyRef.current) { map.once('load', apply); return () => map.off('load', apply); }
    apply();
    return undefined;
  }, [basemap]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tapped POI: OSM's name/class/point from the feature. The dev seam lets
  // the sims drive the exact handler the click uses without vector tiles.
  poiTapRef.current = (f, at) => {
    const p = f?.properties ?? {};
    // a line label (a range, a river) has no point: the tap itself is the place
    const c = f?.geometry?.type === 'LineString' || f?.geometry?.type === 'MultiLineString' ? [at?.lng, at?.lat] : (f?.geometry?.coordinates ?? []);
    if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
    const elevFt = Number.isFinite(p.elevation_ft) ? p.elevation_ft : Number.isFinite(p.elevation_m) ? Math.round(p.elevation_m * 3.28084) : null;
    // OpenMapTiles carries class/subclass; Mapbox Streets carries class/maki
    setPoi({ name: p.name ?? p['name:latin'] ?? p.name_en ?? t('Unnamed place'), cls: p.class ?? '', subclass: p.subclass ?? p.maki ?? '', lng: c[0], lat: c[1], ...(elevFt != null ? { elevFt } : {}) });
  };
  useEffect(() => { if (import.meta.env.DEV) window.__poiTap = (f, at) => poiTapRef.current?.(f, at); }, []);
  // A dropped pin: a needle on the exact spot with the wheel around it — the
  // RouteWheel grammar, adjust and confirm as separate acts. Drag it onto
  // the pullout you meant; the readout in the hint region carries the
  // coordinate and, once named, the road; ✓ adds a placed: 'rider' stop to
  // the open day by route order, ⓘ opens its card, ✕ (or a tap on open map)
  // takes it away.
  const nameDrop = (key, pt) => {
    clearTimeout(geoTimerRef.current);
    geoTimerRef.current = setTimeout(() => {
      reverseGeocode(pt, { near: tRef.current('Near') }).then((g) => {
        if (!g) return;
        setDrop((d) => (d && d.key === key && d.lat === pt.lat && d.lng === pt.lng ? { ...d, name: g.name, detail: g.detail ?? '' } : d));
        setPoi((cur) => (cur?.placed && cur.lat === pt.lat && cur.lng === pt.lng ? { ...cur, name: g.name, detail: g.detail ?? '' } : cur));
      });
    }, 350);
  };
  const dropHandler = (pt) => {
    setWheel(null); wheelRef.current = null; paintDrag();
    setStopSheet(null); setPoi(null);
    const key = Date.now();
    setDrop({ key, lat: pt.lat, lng: pt.lng, name: null, detail: '' });
    nameDrop(key, pt);
  };
  dropHandler.cancel = () => { clearTimeout(geoTimerRef.current); setDrop(null); setPoi((p) => (p?.placed ? null : p)); };
  dropRef.current = dropHandler;
  const moveDrop = ([lng, lat]) => setDrop((d) => (d ? { ...d, lat, lng, name: null, detail: '' } : d));
  const settleDrop = ([lng, lat]) => setDrop((d) => { if (d) nameDrop(d.key, { lat, lng }); return d; });
  const dropPlace = () => (drop ? { name: drop.name ?? coordLabel(drop), lat: drop.lat, lng: drop.lng, cls: '', subclass: '', detail: drop.detail ?? '', placed: 'rider' } : null);
  const addDrop = (place, { fuel = false } = {}) => {
    const day = trip.days.find((d) => d.id === selectedDayId);
    if (!day || !place) return;
    const pt = { lat: place.lat, lng: place.lng };
    dispatch({
      type: 'apply_ops',
      ops: [{
        op: 'add_waypoint', dayId: day.id, index: routeAwareIndex(day, pt),
        waypoint: { name: place.name, ...pt, kind: fuel ? 'fuel' : place.kind === 'photo' ? 'photo' : 'via', ...(fuel ? { fuel: true } : {}), note: place.detail ?? '', placed: place.placed ?? 'rider' },
      }],
    });
    dropHandler.cancel();
  };
  const dropReadout = drop ? `${drop.name ?? coordLabel(drop, 5)}${drop.name ? ` · ${coordLabel(drop, 5)}` : ''}` : '';

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
    const b = pts.reduce((acc, p) => acc.extend(p), new mapboxgl.LngLatBounds(pts[0], pts[0]));
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
    const { trip: t, selectedDayId: sel, routePreview: preview } = stateRef.current;
    ensureTerrain(map, terrainRef.current);
    // our shields are the ones on this map — setStyle brings the basemap's
    // back. Once IDLE: mapbox-gl's placement pass is still running at load and
    // right after a style swap, and flipping a symbol layer's visibility under
    // it throws (an uncaught TypeError in continuePlacement).
    map.once('idle', () => { hideNativeRoadShields(map); liftSatelliteRoads(map); });
    // POI symbols are tappable: say so with the cursor (delegated listeners
    // survive setStyle; register each layer id once)
    for (const id of tappableLayerIds(map)) {
      if (poiHoverRef.current.has(id)) continue;
      poiHoverRef.current.add(id);
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
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
      map.setPaintProperty(`${srcId}-casing`, 'line-color', routeCasing());
      map.setPaintProperty(`${srcId}-line`, 'line-opacity', lineOpacity);
      map.setPaintProperty(`${srcId}-line`, 'line-width', lineWidth(sel === day.id ? 4.5 : 3));
      map.setPaintProperty(`${srcId}-casing`, 'line-width', lineWidth(sel === day.id ? 7 : 5.5));
      map.setPaintProperty(`${srcId}-casing`, 'line-opacity', active ? 0.7 : 0.12);
      map.setPaintProperty(`${srcId}-glow`, 'line-opacity', active ? 0.2 : 0.05);
      map.setPaintProperty(`${srcId}-arrows`, 'icon-opacity', active ? 0.9 : 0);
    }

    // A route-character choice is a draft until the rider confirms it. Draw
    // that draft as one turquoise dashed instrument line over the current
    // colored plan; the map comparison disappears with the sheet on cancel.
    for (const day of t.days) {
      const srcId = `route-preview-${day.id}`;
      const geom = preview?.status === 'ready' ? preview.routes?.[day.id]?.geometry : null;
      const data = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: geom?.length > 1 ? geom : [] },
      };
      if (map.getSource(srcId)) {
        map.getSource(srcId).setData(data);
      } else {
        map.addSource(srcId, { type: 'geojson', data });
        const round = { 'line-cap': 'round', 'line-join': 'round' };
        map.addLayer({
          id: `${srcId}-glow`, type: 'line', source: srcId,
          paint: { 'line-color': '#3ee3d8', 'line-width': lineWidth(9), 'line-opacity': 0.28, 'line-blur': 4 },
          layout: round,
        });
        map.addLayer({
          id: `${srcId}-casing`, type: 'line', source: srcId,
          paint: { 'line-color': '#071014', 'line-width': lineWidth(7), 'line-opacity': 0.86 },
          layout: round,
        });
        map.addLayer({
          id: `${srcId}-line`, type: 'line', source: srcId,
          paint: {
            'line-color': '#3ee3d8', 'line-width': lineWidth(3.5), 'line-opacity': 1,
          },
          layout: round,
        });
      }
      const active = sel === null || sel === day.id;
      map.setPaintProperty(`${srcId}-glow`, 'line-opacity', geom?.length > 1 && active ? 0.2 : 0);
      map.setPaintProperty(`${srcId}-casing`, 'line-opacity', geom?.length > 1 && active ? 0.86 : 0);
      map.setPaintProperty(`${srcId}-line`, 'line-opacity', geom?.length > 1 && active ? 0.96 : 0);
      // Existing route layers can be recreated after a basemap/style change.
      // Reassert the comparison stack so the active route never paints over
      // the proposed geometry merely because its layer was added later.
      map.moveLayer(`${srcId}-glow`);
      map.moveLayer(`${srcId}-casing`);
      map.moveLayer(`${srcId}-line`);
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
    // The place picker's candidates are DOM pins (PlacePins) — a glyph, a
    // name, a tap — not a circle layer: the raster basemaps carry no glyphs
    // for a symbol layer, and a dot with no name has to be matched to the
    // list by eye.
    // The drag proposal rides above everything: dashed turquoise, the color
    // this app reserves for route intelligence and live state. It is not the
    // route until the rider lets go.
    if (!map.getSource('route-drag')) {
      const empty = { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };
      map.addSource('route-drag', { type: 'geojson', data: empty });
      map.addSource('route-drag-pt', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'route-drag-line', type: 'line', source: 'route-drag',
        paint: {
          'line-color': '#3fd0c9', 'line-width': lineWidth(3),
          'line-dasharray': [2, 1.6], 'line-opacity': 0.95,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.addLayer({
        id: 'route-drag-halo', type: 'circle', source: 'route-drag-pt',
        paint: { 'circle-radius': 12, 'circle-color': '#3fd0c9', 'circle-opacity': 0.22 },
      });
      map.addLayer({
        id: 'route-drag-dot', type: 'circle', source: 'route-drag-pt',
        paint: {
          'circle-radius': 6, 'circle-color': '#3fd0c9',
          'circle-stroke-color': '#0b0d10', 'circle-stroke-width': 2,
        },
      });
    }
    paintDrag(); // a style swap mid-drag rebuilt the sources empty
    // prune sources for deleted days
    drawMarkers();
    // Source updates can land in the same commit as the comparison sheet.
    // Explicitly request a frame so the WebGL canvas cannot remain visually
    // one React render behind until another DOM/theme change wakes it.
    map.triggerRepaint();
  }

  // Escape abandons a drag: the route snaps back and nothing is added. A
  // half-made edit the rider cannot back out of is worse than no edit.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      const map = mapRef.current;
      dragRef.current = null;
      setDragging(false);
      paintDrag();
      if (map) { map.dragPan.enable(); map.getCanvas().style.cursor = ''; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A NEW result set frames the map around its pins, once — a search whose
  // results sit off screen is a list, not a map. On a phone the panel is a
  // half sheet at that moment, so the frame keeps clear of it. A row opening
  // later does not re-frame (that is `hot`, not `fit`).
  const [areaMoved, setAreaMoved] = React.useState(false); // the rider panned away since the last frame
  useEffect(() => {
    const map = mapRef.current;
    const pins = (state.pickerPins ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    if (!map || !state.pickerFit || !pins.length) return;
    const b = new mapboxgl.LngLatBounds();
    pins.forEach((p) => b.extend([p.lng, p.lat]));
    const h = containerRef.current?.clientHeight ?? 600;
    map.fitBounds(b, {
      padding: { top: 70, left: 40, right: 40, bottom: ui?.panelHalf ? Math.round(h * 0.55) + 30 : 60 },
      maxZoom: 13, duration: 500,
    });
    setAreaMoved(false);
  }, [state.pickerFit]); // eslint-disable-line react-hooks/exhaustive-deps
  // A rider who pans while a search is open is asking about somewhere else:
  // offer to look there. Only a HAND-moved camera counts (originalEvent), so
  // our own fitBounds never offers to re-search the place it just framed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    // dragstart, not dragend: a pan that ends with the pointer over a pin
    // (the pan slid it there) never gets its dragend, and the rider has still
    // moved the map by hand
    const onEnd = (e) => { if (e.originalEvent) setAreaMoved(true); };
    const onDrag = () => setAreaMoved(true);
    map.on('moveend', onEnd);
    map.on('dragstart', onDrag);
    return () => { map.off('moveend', onEnd); map.off('dragstart', onDrag); };
  }, [mapObj]);

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
      const b = coords.reduce((acc, c) => acc.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: { top: 150, bottom: 90, left: 50, right: 50 }, maxZoom: 13, duration: 700 });
    }
  }, [state.focusLeg, routes]); // eslint-disable-line react-hooks/exhaustive-deps

  // The day's routed line as {lat,lng} — the shape every insertion decision is
  // read off. Null when routing has not answered yet; callers fall back to the
  // straight-line splice, which is exactly right for a straight-line route.
  function dayChain(dayId) {
    const geom = routesRef.current?.[dayId]?.geometry;
    if (!geom || geom.length < 2) return null;
    return geom.map(([lng, lat]) => ({ lat, lng }));
  }

  // Where a new point belongs in the day's ORDER. A point grabbed off the line
  // has an exact along-position, so its leg is known; a point clicked in open
  // space is projected onto the line first, and is only route-ordered if it
  // lands within a few miles of the road.
  function routeAwareIndex(day, pt, { grabbedOnLine = false } = {}) {
    const chain = dayChain(day.id);
    if (chain) {
      if (grabbedOnLine) {
        const hit = alongOnRoute(chain, pt);
        const idx = hit ? insertIndexAtAlong(day.waypoints, chain, hit.along) : null;
        if (idx != null) return idx;
      } else {
        const idx = insertIndexOnRoute(day.waypoints, chain, pt);
        if (idx != null) return idx;
      }
    }
    return bestInsertIndex(day.waypoints, pt);
  }

  const openWheelRef = useRef(() => {});
  openWheelRef.current = (dayId, pt) => {
    const day = stateRef.current.trip.days.find((d) => d.id === dayId);
    if (!day) return;
    const index = routeAwareIndex(day, pt, { grabbedOnLine: true });
    if (index == null) return;
    setWheel({
      key: `${dayId}:${Date.now()}`, // identity of THIS opening, not of the handle position
      dayId,
      index,
      anchor: [pt.lng, pt.lat],
      at: [pt.lng, pt.lat],
      a: day.waypoints[index - 1],
      b: day.waypoints[index],
      movedMi: 0,
    });
  };

  const moveWheel = (at) => {
    setWheel((w) => {
      if (!w) return w;
      const next = { ...w, at, movedMi: haversineMiles({ lng: w.anchor[0], lat: w.anchor[1] }, { lng: at[0], lat: at[1] }) };
      wheelRef.current = next; // paintDrag runs before React commits
      return next;
    });
    paintDrag();
  };

  const confirmWheel = () => {
    const w = wheelRef.current;
    setWheel(null);
    wheelRef.current = null;
    paintDrag();
    if (!w) return;
    const day = stateRef.current.trip.days.find((d) => d.id === w.dayId);
    if (!day) return;
    const vias = day.waypoints.filter((x) => x.kind === 'via').length;
    dispatch({
      type: 'apply_ops',
      ops: [{
        op: 'add_waypoint',
        dayId: w.dayId,
        index: w.index,
        waypoint: { name: `${t('Via')} ${vias + 1}`, lat: w.at[1], lng: w.at[0], kind: 'via' },
      }],
    });
  };

  const closeWheel = () => { setWheel(null); wheelRef.current = null; paintDrag(); };

  // The rubber band while a drag is live: from the stop before the grab,
  // through the cursor, to the stop after it — so the rider can see which
  // stretch of the day they are moving, and that only that stretch moves.
  function paintDrag() {
    const map = mapRef.current;
    if (!map || !map.getSource('route-drag')) return;
    const d = dragRef.current ?? wheelRef.current;
    const coords = d?.a && d?.b ? [[d.a.lng, d.a.lat], d.at, [d.b.lng, d.b.lat]] : [];
    // Setting a source's data fires sourcedata whether or not anything changed,
    // and this runs on every drawAll. Skip the write when there is nothing to
    // paint and nothing painted.
    if (!coords.length && paintedDragRef.current === 0) return;
    paintedDragRef.current = coords.length;
    map.getSource('route-drag').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
    map.getSource('route-drag-pt').setData({
      type: 'FeatureCollection',
      features: d ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: d.at } }] : [],
    });
  }

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
    // Grab the line of the day you are editing and pull it where you want the
    // route to go. Touch is deliberately excluded: the same gesture pans the
    // map, and a phone rider gets the same result by tapping where they want
    // the route — that add is route-ordered too.
    const press = (e) => {
      if (stateRef.current.selectedDayId !== dayId) return;
      if (isTouch() || e.originalEvent?.button !== 0) return;
      beginDragRef.current(dayId, e);
    };
    map.on('mousedown', layerId, press);
    // The 3px line is a hard thing to catch; the glow band around it is the
    // target the rider is actually aiming at.
    map.on('mousedown', layerId.replace(/-line$/, '-glow'), press);
    map.on('mousemove', layerId, (e) => {
      if (dragRef.current) return;
      // a stop marker ON the line owns its own hover — the leg tooltip must
      // not overwrite the stop's (it did: no stop tooltip ever showed on a
      // marker the route ran through)
      if (e.originalEvent?.target?.closest?.('.wp-marker')) return;
      // a tap's synthetic mousemove must not flash the leg tooltip either
      if (isTouch()) return;
      map.getCanvas().style.cursor = stateRef.current.selectedDayId === dayId && !isTouch()
        ? 'grab' : 'pointer';
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
      if (dragRef.current) return;
      map.getCanvas().style.cursor = '';
      hoverPopupRef.current?.remove();
    });
    map.on('click', layerId, (e) => {
      e.originalEvent._wpHandled = true;
      const day = stateRef.current.trip.days.find((d) => d.id === dayId);
      if (!day) return;
      const pt = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      hoverPopupRef.current?.remove();
      // On a phone this tap is the entry to reshaping the route — the wheel
      // carries leg details as one of its options, so nothing is lost.
      if (isTouch() && stateRef.current.selectedDayId === dayId && day.waypoints.length >= 2) {
        openWheelRef.current(dayId, pt);
        return;
      }
      dispatch({ type: 'open_modal', modal: { type: 'leg', dayId, legIndex: nearestLegIndex(day, pt) } });
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
    // NOT `trip: t` — that shadows the i18n t() this function's hover tooltip
    // calls, and the tooltip threw "t is not a function" on every stop hover.
    const { trip: tr, selectedDayId: sel } = stateRef.current;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    labelsRef.current = [];

    const days = sel ? tr.days.filter((d) => d.id === sel) : tr.days;
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
        // the marker's center, so a label underneath never sits on the line.
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
        const marker = new mapboxgl.Marker({ element: el, draggable: showAll })
          .setLngLat([w.lng, w.lat])
          .addTo(map);

        // hover: quick detail tooltip with ETA · click: full stop modal.
        // Pointer-typed: a finger has no hover, and the synthetic mouseenter
        // a touch tap fires flashed the tooltip for one frame before the
        // stop sheet took over (field-caught on the Lead marker).
        el.addEventListener('pointerenter', (ev) => {
          if (ev.pointerType !== 'mouse') return;
          const tl = dayTimeline(day, routedRef.current?.[day.id]);
          const s = tl.stops.find((x) => x.id === w.id);
          hoverPopupRef.current
            .setLngLat([w.lng, w.lat])
            .setHTML(`
              <div class="pp-name">${esc(w.name)}</div>
              <div class="pp-note">${day.dow} · ${s ? `ETA ${fmtTime(s.arrive)}` : ''}${w.fuel ? ' · FUEL' : ''}${w.kind === 'photo' ? ` · ${t('Photo').toUpperCase()}` : ''}</div>
              ${w.note ? `<div class="pp-note">${esc(w.note)}</div>` : ''}
              <div class="pp-note">${t('Click for the stop card')}</div>`)
            .addTo(map);
        });
        el.addEventListener('pointerleave', () => hoverPopupRef.current?.remove());
        // tap: the stop's card (ETA, the leg in, its tag; Edit is one tap on)
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev._wpHandled = true;
          hoverPopupRef.current?.remove();
          setPoi(null);
          setStopSheet({ dayId: day.id, waypointId: w.id });
        });

        if (showAll) {
          marker.on('dragend', () => {
            const ll = marker.getLngLat();
            dispatch({
              type: 'apply_ops',
              // a dragged pin is a deliberate raw coordinate — any old place
              // identity no longer describes where the marker sits
              ops: [{ op: 'update_waypoint', dayId: day.id, waypointId: w.id, patch: { lat: ll.lat, lng: ll.lng, placeId: null, placed: 'rider' } }],
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
    <div className={`map-wrap${['streets', 'light'].includes(basemap) ? ' labels-dark' : ''}${ui?.routeLoad ? ' route-pending' : ''}${dragging ? ' route-dragging' : ''}`}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {/* Real signage on the line the route line was covering up */}
      <RouteShields map={mapObj} placements={shieldMarks} avoid={shieldAvoid} mode="plan" />
      {/* The place picker's candidates: real pins, tap one to open its row */}
      <PlacePins map={mapObj} pins={state.pickerPins} mode="plan" onTap={(id) => dispatch({ type: 'picker_pin_tap', id })} />
      {/* the dropped pin: a needle on the exact spot, draggable, with ✓ add / ✕ / ⓘ */}
      {mapObj && drop && (
        <DropPin
          map={mapObj} drop={drop}
          onMove={moveDrop} onMoveEnd={settleDrop}
          onConfirm={() => (selectedDay ? addDrop(dropPlace()) : setPoi(dropPlace()))}
          onCancel={() => dropHandler.cancel()}
          onDetails={() => setPoi(dropPlace())}
          confirmLabel={selectedDay ? t('Add this spot to the day') : t('Use this spot')}
          detailsLabel={t('Details')}
        />
      )}
      {state.pickerActive && areaMoved && (
        <button
          className="map-area-btn"
          onClick={() => {
            const c = mapRef.current?.getCenter();
            if (!c) return;
            setAreaMoved(false);
            dispatch({ type: 'picker_area', lat: c.lat, lng: c.lng });
          }}
        >⟳ {t('Search this area')}</button>
      )}
      <div className={`map-hint${wheel || drop ? ' wheel' : ''}`}>
        {drop
          ? <>◎ <b>{dropReadout}</b> · {t('drag the pin to adjust')} · {selectedDay ? t('✓ to add it') : t('✓ to use it')}</>
          : wheel
          ? (wheel.movedMi > 0.03
            ? <><b>{u.mi(wheel.movedMi, wheel.movedMi < 10 ? 1 : 0)}</b> {t('off route')} · {t('✓ to place')}</>
            : <>{t('Drag onto the road you want')}</>)
          : selectedDay
          ? <>{t('Editing')} <b>{selectedDay.dow} {selectedDay.date.slice(5)}</b><span className="hint-more"> {isTouch()
              ? t('— tap the map to add a stop · drag markers · tap stops & legs for details')
              : t('— drag the route to reshape it · click the map to add a stop · drag markers')}</span></>
          : <>{t('Whole-trip view')}<span className="hint-more"> {t('— hover a route for leg info, click for details, pick a day to edit')}</span></>}
      </div>
      {/* Touch: tap the route, pull the handle, confirm. */}
      <RouteWheel
        map={mapObj}
        pull={wheel}
        onMove={moveWheel}
        onConfirm={confirmWheel}
        onCancel={closeWheel}
        onDetails={() => {
          const w = wheelRef.current;
          closeWheel();
          if (!w) return;
          const day = trip.days.find((d) => d.id === w.dayId);
          if (day) dispatch({ type: 'open_modal', modal: { type: 'leg', dayId: w.dayId, legIndex: nearestLegIndex(day, { lat: w.anchor[1], lng: w.anchor[0] }) } });
        }}
      />

      {/* Naming a tapped stop — the app's sheet, not window.prompt (which is
          unstyled, unlocalised, and on iOS can be suppressed outright). */}
      {poi && (
        <PoiCard
          poi={poi}
          day={selectedDay ?? null}
          onClose={() => setPoi(null)}
          onAdd={(place, { fuel }) => {
            const day = selectedDay;
            if (!day) return;
            if (place.placed) { addDrop(place, { fuel }); setPoi(null); return; }
            const pt = { lat: place.lat, lng: place.lng };
            dispatch({
              type: 'apply_ops',
              ops: [{
                op: 'add_waypoint', dayId: day.id, index: routeAwareIndex(day, pt),
                waypoint: {
                  name: place.name, ...pt, kind: fuel ? 'fuel' : place.kind === 'photo' ? 'photo' : 'via', ...(fuel ? { fuel: true } : {}), note: place.detail ?? '',
                  ...(place.placeId ? { placeId: place.placeId, verified: place.verified ?? 'google' } : place.placed ? { placed: place.placed } : {}),
                },
              }],
            });
            setPoi(null);
          }}
        />
      )}
      {addAt && (
        <InputSheet
          title={t('Add a stop')}
          label={t('What is here?')}
          placeholder={t('e.g. Palisades Parkway')}
          submitLabel={t('Add stop')}
          onClose={() => setAddAt(null)}
          onSubmit={(name) => dispatch({
            type: 'apply_ops',
            ops: [{
              op: 'add_waypoint',
              dayId: addAt.dayId,
              index: addAt.index,
              waypoint: { name, ...addAt.pt, kind: 'via', placed: 'rider' }, // a tapped spot is the rider's own pin
            }],
          })}
        />
      )}
      {/* A stop's card, from its marker; Edit hands off to the stop editor */}
      {stopSheet && (() => {
        const day = trip.days.find((d) => d.id === stopSheet.dayId);
        const w = day?.waypoints.find((x) => x.id === stopSheet.waypointId);
        if (!day || !w) return null;
        return (
          <StopSheet
            day={day} waypoint={w} trip={trip} routedLegs={routedLegsByDay?.[day.id]}
            onClose={() => setStopSheet(null)}
            onEdit={() => { setStopSheet(null); dispatch({ type: 'open_modal', modal: { type: 'stop', dayId: day.id, waypointId: w.id } }); }}
          />
        );
      })()}
      {/* Keep the previous complete route visible while the latest choice is
          calculated, but name that work so it never reads as a missed click. */}
      {ui?.routeLoad && (
        <div className="routing-chip" role="status" aria-live="polite">
          <span className="routing-dot" />
          {t('Routing')} {ui.routeLoad.done}/{ui.routeLoad.total}…
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

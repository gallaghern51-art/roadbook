import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { STYLE_FALLBACK, MAPBOX_TOKEN, basemapStyle, isStyleLoadError, tappableLayerIds, ensureTerrain } from '../engine/basemaps.js';
import PlacePins from './PlacePins.jsx';
import { attachLongPress } from '../engine/mapGestures.js';
import DropPin from './DropPin.jsx';

// The home screen's map (owner, Sep 13 2026: option A, "map first"). No trip
// on it — this is the map you browse before there is a trip: Mapbox
// satellite-streets near you, its POIs tappable (the same hit-test the plan
// map runs), and the picker's candidates as real pins. Everything else — the
// sheet, the search, the place card — is Home's; this owns the canvas only.
//
//   fix       {lat,lng} | null   the rider (or their home place) → the camera lands there once
//   focus     {lat,lng,at}       a place to fly to (a search result, a picked row)
//   pins      PlacePins rows     the picker's candidates
//   fitAt     number             bump → frame the pins, clear of the sheet
//   sheetPx   number             how much of the bottom the sheet covers (fit padding)
//   drop      {key,lat,lng} | null  the pin the rider dropped (a long press / right-click): a draggable needle with the wheel
//   onDropMove([lng,lat]) · onDropMoveEnd([lng,lat]) · onDropConfirm() · onDropCancel()
//   onPinTap(id) · onPoi(poi|null) · a tap on empty map → onPoi(null) · onCenter({lat,lng}) after every move
//   basemap   'sat' | 'streets' | 'dark' | 'light' — the same styles the trip map switches between
//   terrain3d the 3D toggle (Mapbox's DEM), re-asserted after every style swap
//   onDrop({lat,lng})  a long press (touch) or right-click (mouse) on open map — never a tap
// at: the tap itself, for a feature whose geometry is a line (a range, a
// river — natural_label line labels) rather than a point
const featureToPoi = (f, at) => {
  const p = f?.properties ?? {};
  const g = f?.geometry ?? {};
  const c = /Line/.test(g.type ?? '') ? [at?.lng, at?.lat] : (g.coordinates ?? []);
  if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  const elevFt = Number.isFinite(p.elevation_ft) ? p.elevation_ft : Number.isFinite(p.elevation_m) ? Math.round(p.elevation_m * 3.28084) : null;
  return { name: p.name ?? p['name:latin'] ?? p.name_en ?? 'Unnamed place', cls: p.class ?? '', subclass: p.subclass ?? p.maki ?? '', lng: c[0], lat: c[1], ...(elevFt != null ? { elevFt } : {}) };
};

export default function HomeMap({ fix, focus, pins, fitAt, sheetPx = 0, drop = null, onPinTap, onPoi, onCenter, onBearing, onDrop, onDropMove, onDropMoveEnd, onDropConfirm, onDropCancel, dropLabel, basemap = 'sat', terrain3d = false }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const [mapObj, setMapObj] = useState(null);
  const poiRef = useRef(onPoi);
  poiRef.current = onPoi;
  const centerRef = useRef(onCenter);
  centerRef.current = onCenter;
  const bearingRef = useRef(onBearing);
  bearingRef.current = onBearing;
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  const landedRef = useRef(false);
  const appliedRef = useRef(null);
  const terrainRef = useRef(terrain3d);
  terrainRef.current = terrain3d;

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: divRef.current,
      accessToken: MAPBOX_TOKEN,
      style: (appliedRef.current = basemapStyle(basemap)),
      center: fix ? [fix.lng, fix.lat] : [-108.5, 45.9],
      zoom: fix ? 12.5 : 5.2,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    window.__homeMap = map; // the sims assert on it
    if (fix) landedRef.current = true;
    let fellBack = false;
    map.on('error', (e) => {
      if (fellBack || !isStyleLoadError(e) || map.isStyleLoaded()) return;
      fellBack = true;
      map.setStyle(STYLE_FALLBACK);
    });
    map.on('load', () => {
      setMapObj(map);
      // no route of ours on this map, so the basemap's road numbers stay —
      // they are the only way a rider names US-212 from the home screen
      map.once('idle', () => { ensureTerrain(map, terrainRef.current); });
      for (const id of tappableLayerIds(map)) {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      }
    });
    // where the map is LOOKING is where the chips search — not where the rider is
    map.on('moveend', (e) => { const c = map.getCenter(); centerRef.current?.({ lat: c.lat, lng: c.lng }, { bounds: map.getBounds().toArray(), hand: !!e.originalEvent }); });
    // a HAND pan (dragstart, not dragend — a pan that ends over a pin never gets its dragend) offers "Search this area"
    map.on('dragstart', () => centerRef.current?.(null, { hand: true }));
    // a two-finger twist rotates the map; a North-up button appears while it is turned
    map.on('rotateend', () => bearingRef.current?.(map.getBearing()));
    // a long press / right-click on open map drops a pin; the click that can
    // trail a press is swallowed so it never doubles as a dismiss
    const press = attachLongPress(map, (pt) => dropRef.current?.(pt));
    window.__homePress = (pt) => dropRef.current?.(pt); // sim seam: the same handler a real press reaches
    map.on('click', (e) => {
      if (e.originalEvent?._wpHandled) return; // a pin tap is the pin's
      if (press.recent()) return;
      const ids = tappableLayerIds(map);
      const hits = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : [];
      poiRef.current?.(hits.length ? featureToPoi(hits[0], e.lngLat) : null);
    });
    window.__homePoiTap = (f, at) => poiRef.current?.(f ? featureToPoi(f, at) : null); // dev/sim seam: vector tiles cannot be mocked; null = a tap on open map
    return () => { press.detach(); map.remove(); mapRef.current = null; if (window.__homeMap === map) window.__homeMap = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the layers pill: setStyle, then our shield-hiding and terrain once the new
  // style is idle (the mapbox-gl placement gotcha, see MapView)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const style = basemapStyle(basemap);
    if (appliedRef.current === style) return;
    appliedRef.current = style;
    map.setStyle(style);
    map.once('idle', () => { ensureTerrain(map, terrainRef.current); });
  }, [basemap]);
  const terrainAppliedRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapObj || terrainAppliedRef.current === terrain3d) return; // never on mount: an easeTo here cancels the fix landing
    terrainAppliedRef.current = terrain3d;
    const apply = () => { ensureTerrain(map, terrain3d); map.easeTo({ pitch: terrain3d ? 55 : 0, duration: 800 }); };
    if (map.isStyleLoaded()) apply(); else map.once('idle', apply);
  }, [terrain3d, mapObj]);

  // the first fix lands the camera on the rider; later fixes do not yank it
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fix || landedRef.current) return;
    landedRef.current = true;
    map.easeTo({ center: [fix.lng, fix.lat], zoom: 12.5, duration: 900 });
  }, [fix?.lat, fix?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    // top padding clears the pill + chips + readout, so a focused point (and a
    // dropped pin's ✓ above it) lands in the open part of the map
    map.easeTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), 14), duration: 700, padding: { top: 260, bottom: sheetPx } });
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitAt || !pins?.length) return;
    const b = new mapboxgl.LngLatBounds();
    pins.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: { top: 190, bottom: sheetPx + 24, left: 30, right: 30 }, maxZoom: 14, duration: 600 });
  }, [fitAt]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="hm-map" ref={divRef}>
      {mapObj && <PlacePins map={mapObj} pins={pins ?? []} onTap={onPinTap} />}
      {/* the dropped pin: a needle on the exact spot, draggable, with ✓ / ✕ */}
      {mapObj && drop && <DropPin map={mapObj} drop={drop} onMove={onDropMove} onMoveEnd={onDropMoveEnd} onConfirm={onDropConfirm} onCancel={onDropCancel} confirmLabel={dropLabel} />}
    </div>
  );
}

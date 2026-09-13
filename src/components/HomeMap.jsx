import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { STYLE_FALLBACK, MAPBOX_TOKEN, basemapStyle, isStyleLoadError, hideNativeRoadShields, poiLayerIds } from '../engine/basemaps.js';
import PlacePins from './PlacePins.jsx';

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
//   onPinTap(id) · onPoi(poi|null) · a tap on empty map → onPoi(null) · onCenter({lat,lng}) after every move
const featureToPoi = (f) => {
  const p = f?.properties ?? {};
  const c = f?.geometry?.coordinates ?? [];
  if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return { name: p.name ?? p['name:latin'] ?? p.name_en ?? 'Unnamed place', cls: p.class ?? '', subclass: p.subclass ?? p.maki ?? '', lng: c[0], lat: c[1] };
};

export default function HomeMap({ fix, focus, pins, fitAt, sheetPx = 0, onPinTap, onPoi, onCenter }) {
  const divRef = useRef(null);
  const mapRef = useRef(null);
  const [mapObj, setMapObj] = useState(null);
  const poiRef = useRef(onPoi);
  poiRef.current = onPoi;
  const centerRef = useRef(onCenter);
  centerRef.current = onCenter;
  const landedRef = useRef(false);

  useEffect(() => {
    const map = new mapboxgl.Map({
      container: divRef.current,
      accessToken: MAPBOX_TOKEN,
      style: basemapStyle('sat'),
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
      map.once('idle', () => hideNativeRoadShields(map));
      for (const id of poiLayerIds(map)) {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
      }
    });
    // where the map is LOOKING is where the chips search — not where the rider is
    map.on('moveend', () => { const c = map.getCenter(); centerRef.current?.({ lat: c.lat, lng: c.lng }); });
    map.on('click', (e) => {
      if (e.originalEvent?._wpHandled) return; // a pin tap is the pin's
      const ids = poiLayerIds(map);
      const hits = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : [];
      poiRef.current?.(hits.length ? featureToPoi(hits[0]) : null);
    });
    window.__homePoiTap = (f) => poiRef.current?.(f ? featureToPoi(f) : null); // dev/sim seam: vector tiles cannot be mocked; null = a tap on open map
    return () => { map.remove(); mapRef.current = null; if (window.__homeMap === map) window.__homeMap = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
    map.easeTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), 14), duration: 700, padding: { bottom: sheetPx } });
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
    </div>
  );
}

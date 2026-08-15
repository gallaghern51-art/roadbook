import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';
import RoadShield from './RoadShield.jsx';
import { viewGate } from '../engine/mapVis.js';

// Highway shields riding on the route line — real signage, the same artwork
// the day panel and the turn card use (RoadShield resolves it from
// public/shields or Wikimedia Commons and caches it for a year).
//
// DOM markers rather than a symbol layer: the shields are per-state artwork
// fetched at runtime, and a marker sits above the canvas by construction —
// which is the whole point, since it was the route line's glow/casing/core
// painting over the basemap's own shields that started this.
//
// Placements are DIFFED, not rebuilt: a re-created marker re-mounts its
// RoadShield, which re-resolves the artwork, so a rebuild on every routes
// refresh would blink the signs down the whole line.
//
// Two things are culled on every camera frame:
//   - anything off screen. MapLibre parks off-screen markers in the margins
//     rather than removing them (see engine/mapVis.js).
//   - anything that would land on a shield already kept. What fits at z14
//     does not fit at z8, so this is a camera-time decision, not a
//     placement-time one — the same reasoning as MapView's label culling.
//     A REPEAT of the road you are already on has to earn a lot more room
//     than a road change does: five I-90 shields in a screen is wallpaper,
//     while the one place the sign has to appear is where the number changes.
const GAP_SAME = 150; // px between two shields carrying the same route
const GAP_DIFF = 52;  // px between shields carrying different ones
// A stop marker's own footprint plus a shield's, as half-extents — an actual
// box test, because a radius big enough to clear a marker sideways also
// deletes shields sitting comfortably above and below it, and on a whole-day
// view that is most of them.
const STOP_DX = 30;
const STOP_DY = 22;

export default function RouteShields({ map, placements, avoid }) {
  const marksRef = useRef(new Map()); // id → {p, el, marker}
  const mapRef = useRef(null);
  const [, bump] = useState(0);

  useEffect(() => {
    const have = marksRef.current;
    if (map !== mapRef.current) {
      // a different map owns these markers now — the old ones went with it
      have.forEach((rec) => rec.marker.remove());
      have.clear();
      mapRef.current = map;
    }
    if (!map) return undefined;
    const want = new Map((placements ?? []).map((p) => [p.id, p]));
    let changed = false;

    for (const [id, rec] of [...have]) {
      if (want.has(id)) continue;
      rec.marker.remove();
      have.delete(id);
      changed = true;
    }
    for (const [id, p] of want) {
      const rec = have.get(id);
      if (rec) {
        if (rec.p.lat !== p.lat || rec.p.lng !== p.lng) rec.marker.setLngLat([p.lng, p.lat]);
        if (rec.p.key !== p.key) changed = true;
        rec.p = p;
        continue;
      }
      const el = document.createElement('div');
      el.className = 'rt-shield off'; // hidden until the cull places it
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([p.lng, p.lat])
        .addTo(map);
      have.set(id, { p, el, marker });
      changed = true;
    }
    if (changed) bump((v) => v + 1);
    return undefined;
  }, [map, placements]);

  // cull on every camera frame, and whenever the set itself changes
  useEffect(() => {
    if (!map) return undefined;
    const cull = () => {
      const gate = viewGate(map, { pad: 30 });
      // A shield is a label for a stretch of road; a stop marker is a place
      // you are going. Where they collide the stop wins — it is the one the
      // rider tapped a day panel to look at.
      const stops = (avoid ?? [])
        .map((w) => gate([w.lng, w.lat]))
        .filter(Boolean);
      const kept = [];
      const clearOfKept = (pt, key) => !kept.some((k) => {
        const gap = k.key === key ? GAP_SAME : GAP_DIFF;
        return Math.hypot(k.x - pt.x, k.y - pt.y) < gap;
      });
      // Seating order decides who survives a crowded frame. Road CHANGES go
      // first — a shield that says "you are on US-14 now" is the only one
      // carrying news — then repeats, and within each tier route order, so a
      // road is signed where it starts rather than wherever the scan happened
      // to reach it.
      const order = [...marksRef.current.values()].sort((a, b) =>
        (b.p.first ? 1 : 0) - (a.p.first ? 1 : 0) || a.p.mi - b.p.mi);
      const seats = order.map((rec) => {
        const pt = gate([rec.p.lng, rec.p.lat]);
        const clean = !!pt
          && !stops.some((s) => Math.abs(s.x - pt.x) < STOP_DX && Math.abs(s.y - pt.y) < STOP_DY)
          && clearOfKept(pt, rec.p.key);
        if (clean) kept.push({ x: pt.x, y: pt.y, key: rec.p.key });
        return { rec, pt, ok: clean };
      });
      // Second pass: a road that got NO shield at all. Yielding to stop markers
      // is a tidiness rule, and on a stop-dense day at trip zoom it can eat
      // every placement a road has — leaving half the route unnamed, which is
      // the thing this whole feature exists to fix. So a road with nothing on
      // screen takes the marker overlap and gets its sign.
      const named = new Set(kept.map((k) => k.key));
      for (const seat of seats) {
        if (seat.ok || !seat.pt || named.has(seat.rec.p.key)) continue;
        if (!clearOfKept(seat.pt, seat.rec.p.key)) continue;
        seat.ok = true;
        named.add(seat.rec.p.key);
        kept.push({ x: seat.pt.x, y: seat.pt.y, key: seat.rec.p.key });
      }
      for (const seat of seats) seat.rec.el.classList.toggle('off', !seat.ok);
    };
    cull();
    map.on('move', cull);
    map.on('moveend', cull);
    return () => {
      map.off('move', cull);
      map.off('moveend', cull);
    };
  }, [map, placements, avoid]);

  // unmount: markers are imperative, so they need taking down by hand
  useEffect(() => () => {
    marksRef.current.forEach((rec) => rec.marker.remove());
    marksRef.current.clear();
  }, []);

  return (
    <>
      {[...marksRef.current.values()].map(({ p, el }) => createPortal(
        // Two at most: "US-14/16/20" is three shields, and a wall of them on a
        // moving map reads as clutter rather than as signage.
        p.shields.slice(0, 2).map((s) => <RoadShield key={s.key} road={s} className="map-shield" />),
        el,
        p.id
      ))}
    </>
  );
}

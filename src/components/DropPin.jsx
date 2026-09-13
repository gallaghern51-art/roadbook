import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import mapboxgl from 'mapbox-gl';

// The dropped pin — the same grammar as RouteWheel, because it answers the
// same phone problem (owner, Sep 13 2026: "make it higher quality and more
// precise… you click it and the wheel comes up"). A finger is 40 px wide
// and the spot it wants is 1 px, so adjust and confirm are SEPARATE acts:
//
//   · the NEEDLE's tip is the coordinate — the head sits 40 px above it, so
//     a thumb on the head never hides the point being aimed at, and a
//     crosshair ring marks the tip while it moves;
//   · the pin is a draggable Mapbox GL marker (geo-anchored; Mapbox GL
//     suppresses its own pan for the drag), so the rider slides it onto the
//     pullout, the trailhead, the exact bend they meant;
//   · the satellites commit or back out (✓ use it · ✕ cancel · ⓘ details)
//     and swallow their own pointer events, or pressing one would start a
//     drag.
// The running readout (coordinate to five places, the road once it is
// named) is NOT drawn here — a chip on a marker gets clipped at the screen
// edge; it goes in the map's own hint region, placed once and always
// readable (the RouteWheel lesson).
//
//   map        the loaded Mapbox GL map
//   drop       { key, lng, lat } — key is the identity of THIS drop; moves update lng/lat
//   onMove([lng, lat])  every drag frame · onMoveEnd([lng, lat]) on release
//   onConfirm() · onCancel() · onDetails() (optional — no ⓘ without it)
//   confirmLabel / detailsLabel  aria text
export default function DropPin({ map, drop, onMove, onMoveEnd, onConfirm, onCancel, onDetails, confirmLabel = 'Use this spot', detailsLabel = 'Details' }) {
  const elRef = useRef(null);
  const markerRef = useRef(null);
  const cbRef = useRef({});
  cbRef.current = { onMove, onMoveEnd };
  const [, bump] = useState(0);

  useEffect(() => {
    if (!map || !drop) {
      markerRef.current?.remove();
      markerRef.current = null;
      elRef.current = null;
      return undefined;
    }
    const el = document.createElement('div');
    el.className = 'drop-pin';
    el.setAttribute('data-drop', 'pin');
    // anchor 'bottom': the element's bottom edge — the needle's tip — is the coordinate
    const marker = new mapboxgl.Marker({ element: el, draggable: true, anchor: 'bottom' })
      .setLngLat([drop.lng, drop.lat])
      .addTo(map);
    marker.on('dragstart', () => el.classList.add('dragging'));
    marker.on('drag', () => { const ll = marker.getLngLat(); cbRef.current.onMove?.([ll.lng, ll.lat]); });
    marker.on('dragend', () => { el.classList.remove('dragging'); const ll = marker.getLngLat(); cbRef.current.onMoveEnd?.([ll.lng, ll.lat]); });
    elRef.current = el;
    markerRef.current = marker;
    bump((n) => n + 1); // the portal target exists now
    return () => { marker.remove(); markerRef.current = null; elRef.current = null; };
    // Re-created only for a NEW drop — dragging updates lng/lat constantly, and
    // re-creating the marker mid-drag would drop the finger.
  }, [map, drop?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // a move from outside the drag (a programmatic nudge) follows the state
  useEffect(() => {
    const m = markerRef.current;
    if (!m || !drop) return;
    const ll = m.getLngLat();
    if (ll.lng !== drop.lng || ll.lat !== drop.lat) m.setLngLat([drop.lng, drop.lat]);
  }, [drop?.lng, drop?.lat]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!drop || !elRef.current) return null;

  const own = (fn) => ({
    onPointerDown: (e) => { e.stopPropagation(); },
    onTouchStart: (e) => { e.stopPropagation(); },
    onClick: (e) => { e.stopPropagation(); e.preventDefault(); fn?.(); },
  });

  return createPortal(
    <>
      {/* the tip: a crosshair ring on the exact coordinate */}
      <div className="dp-tip" aria-hidden="true" />
      {/* the needle: grab it anywhere; its point is the spot */}
      <div className="dp-needle" role="img" aria-label="Drag the pin to the exact spot">
        <svg viewBox="0 0 40 56" aria-hidden="true">
          <path className="dp-shadow" d="M20 55c-2-8-14-16-14-30a14 14 0 1 1 28 0c0 14-12 22-14 30z" transform="translate(2 1)" />
          <path className="dp-body" d="M20 55c-2-8-14-16-14-30a14 14 0 1 1 28 0c0 14-12 22-14 30z" />
          <circle className="dp-eye" cx="20" cy="25" r="7.5" />
          <circle className="dp-eye-in" cx="20" cy="25" r="3" />
        </svg>
      </div>
      <button type="button" className="dp-act confirm" {...own(onConfirm)} aria-label={confirmLabel}><span aria-hidden="true">✓</span></button>
      <button type="button" className="dp-act cancel" {...own(onCancel)} aria-label="Cancel"><span aria-hidden="true">✕</span></button>
      {onDetails && <button type="button" className="dp-act info" {...own(onDetails)} aria-label={detailsLabel}><span aria-hidden="true">ⓘ</span></button>}
    </>,
    elRef.current,
  );
}

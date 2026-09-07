import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl from 'maplibre-gl';

// The touch answer to dragging the route line.
//
// A finger cannot hover, and the gesture that would drag the line is the same
// one that pans the map — so on a phone, tapping the route opens this instead:
// a wheel anchored to the point you touched, with a handle you drag to say
// where the road should go and a ring of actions to commit or back out. Adjust
// and confirm are SEPARATE, which is the point: a stray touch on the route can
// never edit the day, and you can take as long as you like lining the pull up.
//
// The handle is a draggable MapLibre marker, so it is geo-anchored (it stays on
// its bit of road while the map moves) and MapLibre suppresses its own pan for
// the duration of the drag — the two things a hand-rolled touch handler here
// would have to fight for.
//
// The satellites stop their own pointer events from reaching the marker, or
// pressing "confirm" would start a drag instead.
//
// The running readout is NOT drawn here: a chip hung off a marker that can sit
// anywhere on the map gets clipped at the screen edge (it did, on the first
// live run at 375px). It goes in the map's own hint region, which is placed
// once and always readable.
export default function RouteWheel({ map, pull, onMove, onConfirm, onCancel, onDetails }) {
  const elRef = useRef(null);
  const markerRef = useRef(null);
  const cbRef = useRef({});
  cbRef.current = { onMove };
  const [, bump] = useState(0);

  useEffect(() => {
    if (!map || !pull) {
      markerRef.current?.remove();
      markerRef.current = null;
      elRef.current = null;
      return undefined;
    }
    const el = document.createElement('div');
    el.className = 'route-wheel';
    const marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'center' })
      .setLngLat(pull.at)
      .addTo(map);
    marker.on('drag', () => {
      const ll = marker.getLngLat();
      cbRef.current.onMove?.([ll.lng, ll.lat]);
    });
    elRef.current = el;
    markerRef.current = marker;
    bump((n) => n + 1); // the portal target exists now
    return () => {
      marker.remove();
      markerRef.current = null;
      elRef.current = null;
    };
    // Re-created only when the wheel opens on a NEW point — dragging updates
    // `pull.at` constantly, and re-creating the marker mid-drag would drop the
    // finger.
  }, [map, pull?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pull || !elRef.current) return null;

  // Keep a satellite from starting the marker's drag.
  const own = (fn) => ({
    onPointerDown: (e) => { e.stopPropagation(); },
    onClick: (e) => { e.stopPropagation(); e.preventDefault(); fn(); },
  });

  return createPortal(
    <>
      <div className="rw-ring" aria-hidden="true" />
      <div className="rw-grip" role="img" aria-label="Drag to pull the route here">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3.2 14.1 6h-1.35v4.75H17.5V9.4L20.3 12 17.5 14.6v-1.35h-4.75V17.5H14.1L12 20.3 9.9 17.5h1.35v-4.25H6.5v1.35L3.7 12 6.5 9.4v1.35h4.75V6H9.9z"
            fill="currentColor"
          />
        </svg>
      </div>
      <button type="button" className="rw-act confirm" {...own(onConfirm)} aria-label="Place a stop here and reroute">
        <span aria-hidden="true">✓</span>
      </button>
      <button type="button" className="rw-act cancel" {...own(onCancel)} aria-label="Cancel">
        <span aria-hidden="true">✕</span>
      </button>
      <button type="button" className="rw-act info" {...own(onDetails)} aria-label="Leg details">
        <span aria-hidden="true">ⓘ</span>
      </button>
    </>,
    elRef.current,
  );
}

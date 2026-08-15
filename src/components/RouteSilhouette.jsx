import React from 'react';
import { PHASES } from '../data/seedTrip.js';

// A trip drawn as its shape: every day's waypoints as a phase-colored line,
// normalized into a small stage. This is the trip's thumbnail — the thing that
// makes one card recognizable from another at a glance, the way a roadbook is
// recognized by the shape of its route. Planning-line geometry, not routed
// roads: at this size the gesture is the information.

export default function RouteSilhouette({ trip, height = 56 }) {
  const pts = trip.days.flatMap((d) => d.waypoints);
  if (pts.length < 2) {
    // an empty trip still gets a stage: a faint dashed road waiting to be drawn
    return (
      <svg className="silhouette" viewBox="0 0 100 60" style={{ height }} aria-hidden="true">
        <line x1="8" y1="30" x2="92" y2="30" stroke="currentColor" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" opacity="0.35" />
      </svg>
    );
  }
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // flatten longitude by cos(midLat) so the shape keeps its real proportions
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const w = Math.max(1e-6, (maxLng - minLng) * kx);
  const h = Math.max(1e-6, maxLat - minLat);
  const W = 100, H = 60, pad = 7;
  const s = Math.min((W - pad * 2) / w, (H - pad * 2) / h);
  const x = (p) => (W - w * s) / 2 + (p.lng - minLng) * kx * s;
  const y = (p) => H - ((H - h * s) / 2 + (p.lat - minLat) * s);
  const first = trip.days[0]?.waypoints[0];
  const lastDay = trip.days[trip.days.length - 1];
  const last = lastDay?.waypoints[lastDay.waypoints.length - 1];
  return (
    <svg className="silhouette" viewBox={`0 0 ${W} ${H}`} style={{ height }} aria-hidden="true">
      {/* Stroke from the CSS var rather than the PHASES hex: both themes define
          these tokens, and the dark-theme hues wash out on a white trip card. */}
      {trip.days.map((d) => d.waypoints.length > 1 && (
        <polyline
          key={d.id}
          points={d.waypoints.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}
          fill="none"
          stroke={PHASES[d.phase] ? `var(--${d.phase})` : 'var(--ink-faint)'}
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.9"
        />
      ))}
      {first && <circle cx={x(first)} cy={y(first)} r="2.6" fill="var(--ink)" />}
      {last && last !== first && <circle cx={x(last)} cy={y(last)} r="2.6" fill="none" stroke="var(--ink)" strokeWidth="1.4" />}
    </svg>
  );
}

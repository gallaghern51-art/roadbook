import React from 'react';
import { FRAME_ROADS, FRAME_WATER, FRAME_PARKS, FRAME_POIS, FRAME_ROUTE, FRAME_PUCK } from '../data/landingFrame.js';

// The landing page's Ride Mode frame, drawn from data we may ship — the
// router's real US-212 out of Red Lodge and OpenStreetMap's streets, water,
// parks and named places around the bike (tools/landing-frame.mjs) — in the
// Dark basemap's palette under Ride Mode's camera: course-up, pitched 55°,
// the bike in the lower third. A visit costs zero map calls and the page ships
// no Mapbox content (their terms do not allow storing a rendered frame); the
// geometry and the names are real, so it is the frame the app would draw here
// rather than a sketch of one.
//
// The ground is one SVG in a CSS 3D plane (perspective + rotateX about the
// bike's row, the way the camera tilts the map); the puck and the place labels
// are HTML projected onto the same plane, so they stay upright and crisp the
// way the app's viewport-aligned markers and labels do.

export const MPP = 1.57;     // metres per pixel at the camera's zoom (512px tiles: 78271.5·cos(lat)/2^15.1)
export const PITCH = 55;     // degrees, Ride Mode's chase camera
export const PERSPECTIVE = 700;
export const PIVOT = [215, 661]; // where the bike sits in the 430×932 frame
const PLANE_W = 2200, PLANE_UP = 3200, PLANE_DOWN = 900;

const sx = (x) => x / MPP;
const sy = (y) => -y / MPP;
const path = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join('');
const closed = (pts) => path(pts) + 'Z';
const len = (pts) => pts.reduce((n, q, i) => (i ? n + Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) : 0), 0);

/** Where a ground point (metres, course-up) lands on the 430×932 screen. */
export function project(x, y) {
  const t = (PITCH * Math.PI) / 180;
  const up = sy(y) * -1; // pixels ahead of the bike on the flat plane
  const s = PERSPECTIVE / (PERSPECTIVE + up * Math.sin(t));
  return [PIVOT[0] + sx(x) * s, PIVOT[1] - up * Math.cos(t) * s, s];
}

const ROAD = {
  service: { w: 2.2, c: '#2b2c2d' },
  street: { w: 4, c: '#363738' },
  secondary: { w: 5.5, c: '#434445' },
  primary: { w: 6.5, c: '#4d4e4f' },
};

export default function LandingFrame() {
  const done = FRAME_ROUTE.slice(0, FRAME_PUCK + 1);
  const ahead = FRAME_ROUTE.slice(FRAME_PUCK);
  // named streets long enough to carry their name, run left→right so the type reads
  const labels = FRAME_ROADS.filter((r) => r.n && r.k !== 'service' && len(r.p) > 220).map((r, i) => {
    const pts = r.p[r.p.length - 1][0] < r.p[0][0] ? [...r.p].reverse() : r.p;
    return { id: `rl${i}`, n: r.n, d: path(pts) };
  });
  const waters = FRAME_WATER.filter((w) => w.k === 'line' && w.n && len(w.p) > 300).map((w, i) => {
    const pts = w.p[w.p.length - 1][0] < w.p[0][0] ? [...w.p].reverse() : w.p;
    return { id: `wl${i}`, n: w.n, d: path(pts) };
  });
  return (
    <div className="rm-map rm-frame" aria-hidden="true">
      {/* the ground lives in its own 3D context: the tilted plane's near edge
          comes toward the viewer, and anything sharing that context sits behind it */}
      <div className="rm-ground">
      <div className="rm-plane" style={{ width: PLANE_W, height: PLANE_UP + PLANE_DOWN, left: PIVOT[0] - PLANE_W / 2, top: PIVOT[1] - PLANE_UP, transformOrigin: `${PLANE_W / 2}px ${PLANE_UP}px` }}>
        <svg viewBox={`${-PLANE_W / 2} ${-PLANE_UP} ${PLANE_W} ${PLANE_UP + PLANE_DOWN}`} width={PLANE_W} height={PLANE_UP + PLANE_DOWN}>
          <rect x={-PLANE_W / 2} y={-PLANE_UP} width={PLANE_W} height={PLANE_UP + PLANE_DOWN} fill="#1c1d1d" />
          <g fill="#1f2521" stroke="none">{FRAME_PARKS.map((q, i) => <path key={i} d={closed(q.p)} />)}</g>
          <g fill="#151b20" stroke="none">{FRAME_WATER.filter((w) => w.k === 'poly').map((q, i) => <path key={i} d={closed(q.p)} />)}</g>
          <g fill="none" stroke="#1e2d38" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">{FRAME_WATER.filter((w) => w.k === 'line').map((q, i) => <path key={i} d={path(q.p)} />)}</g>
          {['service', 'street', 'secondary', 'primary'].map((k) => (
            <g key={k} fill="none" stroke={ROAD[k].c} strokeWidth={ROAD[k].w} strokeLinecap="round" strokeLinejoin="round">
              {FRAME_ROADS.filter((r) => r.k === k).map((r, i) => <path key={i} d={path(r.p)} />)}
            </g>
          ))}
          <defs>{labels.map((l) => <path key={l.id} id={l.id} d={l.d} />)}{waters.map((l) => <path key={l.id} id={l.id} d={l.d} />)}</defs>
          <g fill="#4e6b80" fontFamily="Barlow, system-ui, sans-serif" fontSize="12" fontStyle="italic" stroke="#1c1d1d" strokeWidth="2.4" paintOrder="stroke">
            {waters.map((l) => <text key={l.id} dy="-6"><textPath href={`#${l.id}`} startOffset="50%" textAnchor="middle">{l.n}</textPath></text>)}
          </g>
          <g fill="#8d8f90" fontFamily="Barlow, system-ui, sans-serif" fontSize="12" fontWeight="500" letterSpacing="0.02em" stroke="#1c1d1d" strokeWidth="2.4" paintOrder="stroke">
            {labels.map((l) => <text key={l.id} dy="4"><textPath href={`#${l.id}`} startOffset="50%" textAnchor="middle">{l.n}</textPath></text>)}
          </g>
          {/* the route: the completed piece opaque and glowless, the road ahead lit */}
          <path d={path(done)} fill="none" stroke="#0b1416" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
          <path d={path(done)} fill="none" stroke="#264f51" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d={path(ahead)} fill="none" stroke="#56c5c8" strokeWidth="18" strokeLinecap="round" strokeLinejoin="round" opacity="0.2" />
          <path d={path(ahead)} fill="none" stroke="#0b1416" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
          <path d={path(ahead)} fill="none" stroke="#56c5c8" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      </div>
      {FRAME_POIS.map((q) => {
        const [x, y, s] = project(q.x, q.y);
        if (y < 230 || y > 720 || x < 20 || x > 410) return null;
        return (
          <div key={q.n} className={`rm-poi k-${q.k}`} style={{ left: x, top: y, fontSize: 11 + 2 * s }}>
            <i /><span>{q.n}</span>
          </div>
        );
      })}
      <div className="rm-puck" style={{ left: PIVOT[0], top: PIVOT[1] }}><div className="nav-puck" /></div>
      <div className="rm-credit">© OpenStreetMap contributors</div>
    </div>
  );
}

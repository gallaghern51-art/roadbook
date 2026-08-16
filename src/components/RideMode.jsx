import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { useTrip } from '../engine/store.js';
import { dayTimeline, fmtTime, fmtDur, parseTime, planTargetAt } from '../engine/timeline.js';
import {
  haversineMiles, tripRange, tripPace, projectOnChain, projectOnChainDirected,
  chainCursor, bestInsertIndex, mercatorCum, lineProgressAt,
} from '../engine/tripEngine.js';
import { viewGate } from '../engine/mapVis.js';
import { routeDaySteps, routeFrom } from '../engine/routing.js';
import { speedLimitTracker } from '../engine/speedLimit.js';
import {
  createNav, syncNav, navTarget, navRemaining, navFix,
  navGoNext, navSkip, navRestore, navInitVisited, navArriveAt, PARK_MPH,
} from '../engine/rideNav.js';
import { geocode } from '../engine/geocode.js';
import { STYLE_SATELLITE, STYLE_STREETS, STYLE_DARK, STYLE_LIGHT, warmTilesAhead, hideNativeRoadShields, cachedGoogleStyle, googleStyle, GOOGLE_KEY } from '../engine/basemaps.js';
import { fmtDayDate } from '../engine/dates.js';
import { fetchConditionsAhead } from '../engine/conditions.js';
import WeatherIcon from './WeatherIcon.jsx';
import RoadShield from './RoadShield.jsx';
import RouteShields from './RouteShields.jsx';
import { stepRoadShields } from '../engine/roads.js';
import { shieldPlacements } from '../engine/routeShields.js';
import { stepAlongs, navAlongRoute } from '../engine/rideDistance.js';
import { useT, useTT, useUnits, useSettings } from '../engine/settings.jsx';

// Ride Mode: a navigation HUD over a live map. Projects your GPS position onto
// the planned route and answers the questions that matter at 70 mph: where do I
// turn next, and am I ahead of or behind the plan? Off route, it recalculates
// from where you actually are — like any real nav app.

const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

// ---------- lane guidance ----------
// Road-paint arrows, not rotated clip-art. A real lane arrow has a shaft that
// rises in the direction of travel and *bends* into the turn, ending in a solid
// head — rotating one straight arrow 90 degrees is what makes nav UIs look
// homemade. Each glyph below is a bent shaft (thick round stroke) plus a filled
// triangular head placed at the end of that bend.
//
// Lit lanes are the ones that carry you through the next maneuver; unlit lanes
// are drawn dim rather than hidden, because the count is the information — you
// need to know you want the second of four, not just "a left lane".
const HEAD = 'M0 -4.9 L4.3 3.1 L-4.3 3.1 Z'; // tip at origin, pointing up

// shaft path + where the head sits at the end of it, per OSRM indication
const LANE_GLYPH = {
  'none': { d: 'M12 21 V5', head: null },
  'straight': { d: 'M12 21 V10.6', head: [12, 8.2, 0] },
  'slight right': { d: 'M12 21 V15.5 Q12 11.6 15.3 9.6', head: [17.2, 8.4, 45] },
  'right': { d: 'M12 21 V14.5 Q12 9.8 16.7 9.8', head: [19.1, 9.8, 90] },
  'sharp right': { d: 'M12 21 V14.5 Q12 8.6 16.4 10.9', head: [18.3, 12.0, 135] },
  'slight left': { d: 'M12 21 V15.5 Q12 11.6 8.7 9.6', head: [6.8, 8.4, -45] },
  'left': { d: 'M12 21 V14.5 Q12 9.8 7.3 9.8', head: [4.9, 9.8, -90] },
  'sharp left': { d: 'M12 21 V14.5 Q12 8.6 7.6 10.9', head: [5.7, 12.0, -135] },
  'uturn': { d: 'M15.4 21 V12.6 A3.4 3.4 0 0 0 8.6 12.6 V15.4', head: [8.6, 17.8, 180] },
};
// merges read as the shallow version of the same move
LANE_GLYPH['merge to right'] = LANE_GLYPH['slight right'];
LANE_GLYPH['merge to left'] = LANE_GLYPH['slight left'];

function LaneArrow({ ind, className = 'lane-arrow' }) {
  const g = LANE_GLYPH[ind] ?? LANE_GLYPH.straight;
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path d={g.d} fill="none" stroke="currentColor" strokeWidth="3.1" strokeLinecap="butt" />
      {g.head && (
        <path d={HEAD} fill="currentColor" transform={`translate(${g.head[0]} ${g.head[1]}) rotate(${g.head[2]})`} />
      )}
    </svg>
  );
}

// The maneuver arrow speaks the same language as the lane arrows — same bent
// shafts, same solid heads — so the banner reads as one drawing rather than a
// road marking sitting beside a rotated clip-art arrow. Roundabout and arrive
// are drawn too: they used to be the characters U+27F3 and U+2691, which render
// as whatever the platform feels like, up to and including colour emoji.
function TurnArrow({ step }) {
  if (!step) return null;
  if (step.type === 'arrive') {
    return (
      <svg viewBox="0 0 24 24" className="turn-arrow">
        <path d="M6.4 21.8 V2.6" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
        <path d="M7.8 3.4 H19.6 L16.5 8 L19.6 12.6 H7.8 Z" fill="currentColor" />
      </svg>
    );
  }
  if (step.type === 'roundabout' || step.type === 'rotary') {
    return (
      <svg viewBox="0 0 24 24" className="turn-arrow">
        <circle cx="11" cy="10.8" r="4.8" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="M11 21.6 V16.4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="butt" />
        <path d="M14.6 8.2 L17.4 6.2" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="butt" />
        <path d={HEAD} fill="currentColor" transform="translate(19.2 5) rotate(55)" />
      </svg>
    );
  }
  return <LaneArrow ind={step.mod ?? 'straight'} className="turn-arrow" />;
}

function LaneStrip({ lanes }) {
  if (!lanes?.length) return null;
  return (
    <div className="lane-strip" aria-hidden="true">
      {lanes.map((l, i) => (
        <span key={i} className={`lane${l.v ? ' on' : ''}`}>
          {(l.i.length ? l.i : ['none']).map((ind, j) => <LaneArrow key={j} ind={ind} />)}
        </span>
      ))}
    </div>
  );
}

// OSRM writes route refs as "I 90" or "I 90;US 191", Google puts the road in
// the instruction and nowhere else — stepRoadShields reads both.
const stepShields = (step) => stepRoadShields(step).slice(0, 2);

const fmtStepDist = (mi) => {
  if (mi >= 10) return `${Math.round(mi)} mi`;
  if (mi >= 0.19) return `${mi.toFixed(1)} mi`;
  return `${Math.max(50, Math.round((mi * 5280) / 50) * 50)} ft`;
};

// A moving position keeps its heading only when it means something — GPS
// course below walking-out-of-a-lot speed is noise, and a parked bike may
// legally face either way. Shared by every chain projection and navOrigin.
const fixHeading = (f) => (f && f.heading != null && (f.speedMph ?? 0) > 4 ? f.heading : null);

// Position on the plan: leg index, planned clock minutes, miles done.
// Projections go through a chainCursor: out-and-back days carry the same
// corridor twice, and the cursor's heading + continuity preferences are what
// keep the match on the copy the bike is actually riding (see tripEngine).
function planPosition(day, tl, pos, cursor) {
  const wps = day.waypoints;
  if (wps.length < 2) return null;
  const best = cursor
    ? cursor.project(wps, pos, { heading: fixHeading(pos) })
    : projectOnChain(wps, pos);
  if (!best) return null;
  const seg = tl.stops[best.i + 1];
  const plannedMin = tl.stops[best.i].depart + best.f * (seg?.legMin ?? 0);
  let doneMiles = 0;
  for (let k = 1; k <= best.i; k++) doneMiles += tl.stops[k].legMiles;
  doneMiles += best.f * (seg?.legMiles ?? 0);
  return { ...best, plannedMin, doneMiles, remainToNext: (1 - best.f) * (seg?.legMiles ?? 0), dist: best.off };
}

// Position on the maneuver chain: next turn, miles to it, what's left of the
// CURRENT LEG (up to the next arrive maneuver — the number a rider actually
// wants at speed), and what's left of the whole day.
function locateOnSteps(steps, pos, cursor) {
  if (!steps || steps.length < 2) return null;
  const best = cursor
    ? cursor.project(steps, pos, { heading: fixHeading(pos) })
    : projectOnChain(steps, pos);
  if (!best) return null;
  const cur = steps[best.i];
  const toNext = Math.max(0, (1 - best.f) * cur.dist);
  let remMi = toNext;
  let remSec = Math.max(0, (1 - best.f) * (cur.sec ?? 0));
  let legMi = remMi;
  let legSec = remSec;
  let legEnd = null; // index of the arrive step closing the current leg
  for (let j = best.i + 1; j < steps.length; j++) {
    if (legEnd == null && steps[j].type === 'arrive') legEnd = j;
    if (legEnd == null) { legMi += steps[j].dist; legSec += steps[j].sec ?? 0; }
    remMi += steps[j].dist;
    remSec += steps[j].sec ?? 0;
  }
  const legStep = legEnd != null ? steps[legEnd] : steps[steps.length - 1];
  return {
    next: steps[best.i + 1], after: steps[best.i + 2] ?? null, idx: best.i + 1,
    toNext, off: best.off,
    remMi, remMin: remSec / 60,
    legMi, legMin: legSec / 60, legStop: legStep?.stop ?? null,
  };
}

// Destination control lives in src/engine/rideNav.js — a pure fact machine
// (visited / skipped / pinned), rebuilt after the projection-mixed index
// version resurrected departed stops and auto-skipped chosen destinations.

const NAV_AHEAD = '#ffab5c';
const NAV_BEYOND = '#9c6a38'; // muted amber — the day beyond the current leg
const NAV_DONE = 'rgba(122, 122, 122, 0.65)';
const SOLID_AHEAD = ['interpolate', ['linear'], ['line-progress'], 0, NAV_AHEAD, 1, NAV_AHEAD];
const EMPTY_LINE = { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } };

// Planned route + live-reroute layer stacks. Google-style: soft glow, dark
// casing, bright line whose traveled portion dims behind you (line-gradient).
function ensureNavLayers(map) {
  if (map.getSource('ride-route')) return;
  map.addSource('ride-route', { type: 'geojson', data: EMPTY_LINE, lineMetrics: true });
  map.addSource('ride-live', { type: 'geojson', data: EMPTY_LINE, lineMetrics: true });
  const round = { 'line-cap': 'round', 'line-join': 'round' };
  map.addLayer({ id: 'ride-route-glow', type: 'line', source: 'ride-route', paint: { 'line-color': '#f48322', 'line-width': 14, 'line-opacity': 0.3, 'line-blur': 4 }, layout: round });
  map.addLayer({ id: 'ride-route-casing', type: 'line', source: 'ride-route', paint: { 'line-color': '#000000', 'line-width': 9.5, 'line-opacity': 0.85 }, layout: round });
  map.addLayer({ id: 'ride-route-line', type: 'line', source: 'ride-route', paint: { 'line-color': NAV_AHEAD, 'line-width': 5.5, 'line-opacity': 0.95 }, layout: round });
  map.addLayer({ id: 'ride-live-casing', type: 'line', source: 'ride-live', paint: { 'line-color': '#000000', 'line-width': 9.5, 'line-opacity': 0.85 }, layout: round });
  map.addLayer({ id: 'ride-live-line', type: 'line', source: 'ride-live', paint: { 'line-color': NAV_AHEAD, 'line-width': 5.5, 'line-opacity': 0.95 }, layout: round });
}


// Line-art chip icons, drawn to match the HUD rather than borrowing system
// glyphs — emoji (⛽ ⏱ ⚑) render as coloured tiles on most platforms and
// clash with everything else on this screen.
function FuelPumpIcon({ className = 'mc-ic' }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <path d="M4 17V5a1.5 1.5 0 0 1 1.5-1.5H10A1.5 1.5 0 0 1 11.5 5v12M3 17h9.5M11.5 8.5H14a1.5 1.5 0 0 1 1.5 1.5v4.2a1.15 1.15 0 1 0 2.3 0V7.4L16 5.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ClockIcon({ className = 'mc-ic' }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10 6.2V10l2.9 1.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FlagIcon({ className = 'mc-ic' }) {
  return (
    <svg viewBox="0 0 20 20" className={className} aria-hidden="true">
      <path d="M5.5 17V3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M5.5 4h9l-2.2 3 2.2 3h-9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Line-art speaker, drawn to match the HUD rather than borrowing a system glyph
// (an emoji speaker renders as a coloured tile on most platforms).
function SpeakerIcon({ muted }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return (
    <svg viewBox="0 0 22 22" className="spk-icon" aria-hidden="true">
      <path d="M4 8.5h3l4.5-3.5v12L7 13.5H4z" {...stroke} />
      {muted ? (
        <path d="M15 8.5l4.5 5M19.5 8.5l-4.5 5" {...stroke} />
      ) : (
        <>
          <path d="M15 8a4.2 4.2 0 0 1 0 6" {...stroke} />
          <path d="M17.6 5.8a7.4 7.4 0 0 1 0 10.4" {...stroke} />
        </>
      )}
    </svg>
  );
}

// Nav map looks. Satellite is the default because terrain reads better at speed;
// streets is the fallback when imagery is too busy, and dark suits night riding.
const NAV_STYLES = [
  { key: 'hybrid', label: 'Satellite' },
  { key: 'streets', label: 'Streets' },
  { key: 'dark', label: 'Dark' },
  { key: 'light', label: 'Light' },
];

const navStyleFor = (key) => (
  key === 'streets' ? STYLE_STREETS
    : key === 'dark' ? STYLE_DARK
      : key === 'light' ? STYLE_LIGHT
        : cachedGoogleStyle('hybrid') ?? STYLE_SATELLITE
);


// A stop name is often longer than a phone is wide. Rather than truncate it,
// this scrolls it — one direction, looping, not ping-ponging back and forth.
// The text is rendered twice and shifted by exactly one copy plus the gap, so
// the second copy lands where the first began and the seam is invisible.
// Only overflowing text moves; short names sit still.
const MQ_GAP = 44; // px between the two copies — must match .mq-ink gap
const MQ_SPEED = 26; // px per second, so long and short names read the same

// Chase-camera zoom vs speed — CONTINUOUS, because the old 25/50 mph tier
// steps pumped the camera a full level whenever a cruise wavered around a
// tier edge (half of South Dakota sits at 48–52 mph). Anchors keep the
// Google-like framing the tiers had — 16.2 in town, 15.2 at back-road pace,
// 14.3 at highway speed — easing to 14.0 at a true interstate cruise so the
// look-ahead grows with the speed.
const ZOOM_ANCHORS = [[20, 16.2], [35, 15.2], [55, 14.3], [75, 14.0]];
function speedZoom(mph) {
  if (mph == null) return 15.2;
  let [px, pz] = ZOOM_ANCHORS[0];
  if (mph <= px) return pz;
  for (const [x, z] of ZOOM_ANCHORS) {
    if (mph <= x) return pz + ((mph - px) / (x - px)) * (z - pz);
    px = x; pz = z;
  }
  return pz;
}
const ZOOM_HOLD_MS = 12000; // how long a pinched zoom / a map touch holds off the camera


function Marquee({ className, label, text }) {
  const boxRef = useRef(null);
  const segRef = useRef(null);
  const inkRef = useRef(null);
  const [runs, setRuns] = useState(false);

  useEffect(() => {
    const box = boxRef.current;
    const seg = segRef.current;
    const ink = inkRef.current;
    if (!box || !seg || !ink) return;
    const segW = seg.scrollWidth;
    // Any overflow at all clips a character, so scroll on 1px — a name that
    // ends in a sliced "a" reads as a typo at 70 mph.
    const over = segW - box.clientWidth > 1;
    setRuns(over);
    if (over) {
      const shift = segW + MQ_GAP;
      ink.style.setProperty('--shift', `${-shift}px`);
      ink.style.setProperty('--dur', `${shift / MQ_SPEED}s`);
    }
  }, [text]);

  // The label sits OUTSIDE the clipping box: inside it, the text slid underneath
  // the label instead of being cut at the edge of the scroll window.
  return (
    <div className={`${className} mq-row`}>
      {label && <i className="mq-label">{label}</i>}
      <div className="mq-box" ref={boxRef}>
        <span className={`mq-ink${runs ? ' runs' : ''}`} ref={inkRef}>
          <span className="mq-seg" ref={segRef}>{text}</span>
          {runs && <span className="mq-seg" aria-hidden="true">{text}</span>}
        </span>
      </div>
    </div>
  );
}

export default function RideMode({ onClose }) {
  const { state, routes, routedLegsByDay, dispatch } = useTrip();
  const { trip } = state;
  const today = new Date().toLocaleDateString('sv-SE');
  const defaultDay = trip.days.find((d) => d.date === today)?.id ?? state.selectedDayId ?? trip.days[0]?.id;
  const [dayId, setDayId] = useState(defaultDay);
  const [fix, setFix] = useState(null); // {lat,lng,speedMph,heading,accuracy,at}
  const [geoErr, setGeoErr] = useState(null);
  const failSince = useRef(null); // when the fix started failing, for the grace period
  const [clock, setClock] = useState(nowMin());
  const [steps, setSteps] = useState(null);
  const [mapObj, setMapObj] = useState(null); // the loaded nav map, for marker children
  const [reroute, setReroute] = useState(null); // { geometry, steps } from live position
  const [rerouting, setRerouting] = useState(false);
  const [rerouteFailed, setRerouteFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const [muted, setMuted] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false); // the ride sheet — everything that isn't glanceable
  const [navStyle, setNavStyle] = useState('hybrid');
  // Camera grammar, Google-style: track-up is the tilted chase view; north-up
  // is flat overhead with the puck arrow carrying the heading. The compass
  // rose toggles between them and its needle always shows true map north.
  const [camMode, setCamMode] = useState('track'); // track | north
  const [ahead, setAhead] = useState(null); // conditions a few miles up the road
  // Destination control: the rideNav fact machine — visited / skipped /
  // pinned. See src/engine/rideNav.js for the full contract.
  const [dest, setDest] = useState(() => createNav());
  const [undoSkip, setUndoSkip] = useState(null); // {id, name} — last auto-skip
  // Gate margins are an alert, not furniture: once the rider has seen one
  // ("Needles Hwy entry · 5h 09m LATE" pinned over Deadwood all afternoon,
  // field feedback) it can be ✕'d away. Per gate, per ride session — a NEW
  // next gate always announces itself.
  const [gateHidden, setGateHidden] = useState(() => new Set());
  const [limit, setLimit] = useState(null); // {mph, ref} — posted speed limit here
  const [liveEta, setLiveEta] = useState(null); // {min, at} — traffic-aware time over the remaining route
  // add-a-stop search: gas, food, a place — inserted into the CURRENT leg
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null); // null = idle, [] = no matches
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(null);
  const wpMarkersRef = useRef([]);
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  const { density, set } = useSettings();
  const lean = density === 'minimal';
  const statsRef = useRef({ miles: 0, maxMph: 0, last: null });
  const wakeRef = useRef(null);
  const mapDivRef = useRef(null);
  const mapRef = useRef(null);
  const mapReadyRef = useRef(false); // the map's own `load` has fired — see whenMapReady
  const puckRef = useRef(null);
  const followRef = useRef(true);
  followRef.current = follow;
  const hadFixRef = useRef(false); // live positioning has begun
  const zoomHoldRef = useRef(null); // { z, at } — the rider's pinched zoom, held ZOOM_HOLD_MS
  const pinchingRef = useRef(false); // a user gesture (not our easeTo) is driving the zoom
  const lastTouchRef = useRef(0); // last deliberate map interaction — gates auto-recenter
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const spokenRef = useRef('');
  const offCountRef = useRef(0);
  const warmAtRef = useRef(0);
  const liveRouteAtRef = useRef(0);
  const lastRerouteAtRef = useRef(0);
  const reroutingRef = useRef(false);
  reroutingRef.current = rerouting;
  const camModeRef = useRef('track');
  camModeRef.current = camMode;
  const compassRef = useRef(null); // the rose needle — rotated straight on the DOM, no re-render per frame
  const destRef = useRef(null);
  destRef.current = dest;
  const rerouteRef = useRef(null);
  rerouteRef.current = reroute;
  const projRef = useRef(null);
  const limiterRef = useRef(null); // speed-limit tracker, one per ride
  const onPlanRef = useRef(0); // consecutive fixes back on the planned line
  const initLatchRef = useRef(false); // one-time late-start latch, per day session
  const puckPosRef = useRef(null); // last PAINTED puck position — glide start point
  const puckAnimRef = useRef(0);
  const mountedRef = useRef(true);
  // One direction-aware projection cursor per chain the bike is tracked on
  // (routed geometry / maneuver steps / waypoint legs). Each remembers its
  // own along-position; a chain identity change resets it naturally.
  const geoCursorRef = useRef(null);
  const stepsCursorRef = useRef(null);
  const planCursorRef = useRef(null);
  // re-arm in the body: StrictMode's dev double-mount runs the cleanup once,
  // and a ref initializer alone would leave this false forever after it
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try { audioCtxRef.current?.close(); } catch { /* already closed */ }
      audioCtxRef.current = null;
    };
  }, []);

  const day = trip.days.find((d) => d.id === dayId) ?? trip.days[0];
  const pace = tripPace(trip);
  const tl = useMemo(() => dayTimeline(day, routedLegsByDay[day.id]), [day, routedLegsByDay]);
  const totalMiles = tl.stops.reduce((a, s) => a + s.legMiles, 0);

  // Speech must be woken from inside a user gesture on iOS and Android Chrome —
  // an utterance queued from a GPS-fix effect before any gesture-context
  // speak() is silently dropped, which reads as "voice never works". The first
  // tap anywhere in Ride Mode speaks a muted blank to unlock the engine, AND
  // starts a silent audio session: without one, iOS routes speech through the
  // RINGER channel, so a phone with the silent switch on (every rider's phone)
  // hears nothing. A zero-gain looping buffer flips the app into the media-
  // playback session, which the silent switch does not mute.
  const voiceReadyRef = useRef(false);
  const audioCtxRef = useRef(null);
  const voiceRef = useRef(null); // resolved English voice — see below
  const utterKeepRef = useRef(null); // GC guard: a collected utterance goes silent mid-queue
  const unlockVoice = () => {
    if (!('speechSynthesis' in window)) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !audioCtxRef.current) {
        const ctx = new AC();
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050); // one silent sample, looped
        src.loop = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        src.connect(g).connect(ctx.destination);
        src.start(0);
        audioCtxRef.current = ctx;
      }
      audioCtxRef.current?.resume?.();
    } catch { /* no audio session — speech follows the ringer switch */ }
    if (voiceReadyRef.current) return;
    voiceReadyRef.current = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch { /* no speech engine */ }
  };

  // Pin a concrete English voice once the list loads — iOS standalone builds
  // have shipped with a default voice that never resolves, which also reads
  // as "voice never works".
  useEffect(() => {
    if (!('speechSynthesis' in window)) return undefined;
    const pick = () => {
      try {
        const vs = window.speechSynthesis.getVoices?.() ?? [];
        voiceRef.current = vs.find((v) => v.lang?.startsWith('en') && v.localService)
          ?? vs.find((v) => v.lang?.startsWith('en')) ?? null;
      } catch { /* keep default */ }
    };
    pick();
    window.speechSynthesis.addEventListener?.('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', pick);
  }, []);

  const speak = (text) => {
    if (!text || mutedRef.current || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; // nav instructions are English regardless of UI language
      if (voiceRef.current) u.voice = voiceRef.current;
      utterKeepRef.current = u; // hold the reference until it finishes
      u.onend = () => { if (utterKeepRef.current === u) utterKeepRef.current = null; };
      // cancel() followed by speak() in the same tick swallows the new
      // utterance on Chrome — give the engine a beat to clear the queue.
      if (synth.speaking || synth.pending) {
        synth.cancel();
        setTimeout(() => {
          try { synth.resume(); synth.speak(u); } catch { /* engine gone */ }
        }, 80);
      } else {
        synth.resume(); // Chrome wedges itself paused after tab switches
        synth.speak(u);
      }
    } catch { /* no voice — HUD still works */ }
  };

  // ---- nav map with position puck ----
  useEffect(() => {
    const start = day.waypoints[0];
    // Google hybrid when a tile session is cached; otherwise Esri now and warm
    // a session in the background so the next ride opens on Google.
    if (GOOGLE_KEY) googleStyle('hybrid').catch(() => {});
    const map = new maplibregl.Map({
      container: mapDivRef.current,
      style: cachedGoogleStyle('hybrid') ?? STYLE_SATELLITE,
      center: start ? [start.lng, start.lat] : [-108, 45],
      zoom: 12,
      attributionControl: false, // shown in the hub instead — see below
      maxTileCacheSize: 1024, // keep ridden-past tiles around for overview jumps
    });
    mapRef.current = map;
    // console/sim debugging — the GPS-sim SOP asserts on the nav map's paint
    // properties, and the sims drive the BUILT app, so this isn't dev-gated
    window.__rideMap = map;
    mapReadyRef.current = false;
    map.once('load', () => {
      mapReadyRef.current = true;
      // one set of shields on this screen, ours — see hideNativeRoadShields
      hideNativeRoadShields(map);
      setMapObj(map);
    });
    map.on('dragstart', () => { lastTouchRef.current = Date.now(); setFollow(false); });
    // Pinch-zoom does NOT break follow — the camera kept re-asserting its
    // computed zoom every fix, snapping back a rider who pinched out to peek
    // ahead. Instead the pinched zoom becomes a hold (Google's grammar): the
    // chase keeps chasing at the rider's framing, then breathes back to the
    // speed curve after ZOOM_HOLD_MS. Wheel is the desktop stand-in.
    const cv = map.getCanvas();
    cv.addEventListener('touchstart', (e) => {
      lastTouchRef.current = Date.now();
      if (e.touches.length >= 2) pinchingRef.current = true;
    }, { passive: true });
    cv.addEventListener('wheel', () => { lastTouchRef.current = Date.now(); pinchingRef.current = true; }, { passive: true });
    map.on('zoomend', () => {
      if (pinchingRef.current) {
        pinchingRef.current = false;
        zoomHoldRef.current = { z: map.getZoom(), at: Date.now() };
      }
    });
    // the rose needle tracks true map north on every frame of rotation
    map.on('rotate', () => {
      if (compassRef.current) compassRef.current.style.transform = `rotate(${-map.getBearing()}deg)`;
    });

    const el = document.createElement('div');
    el.className = 'nav-puck';
    puckRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      .setLngLat(start ? [start.lng, start.lat] : [-108, 45])
      .addTo(map);

    return () => { setMapObj(null); map.remove(); mapRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Run something that touches sources and layers as soon as the map can take
  // it. The old test was isStyleLoaded(), which is false whenever ANY tile is
  // in flight — on satellite at 74 mph that is nearly always — so every later
  // call fell through to `once('load')`, a one-shot that had already fired at
  // startup and would never fire again. A route drawn after Ride opened, a day
  // switched mid-ride, a live reroute: all silently never reached the map.
  // What actually gates addSource/addLayer is the map's own load (mapReadyRef).
  const whenMapReady = (map, fn) => {
    if (!mapReadyRef.current) { map.once('load', fn); return; }
    // the one moment layers can be missing afterwards is a basemap swap, where
    // setStyle has dropped them and the new style is still parsing
    try { fn(); } catch { map.once('styledata', fn); }
  };

  // draw / update the day's planned route line on the nav map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const geom = routes[day.id]?.geometry ?? day.waypoints.map((w) => [w.lng, w.lat]);
    whenMapReady(map, () => {
      ensureNavLayers(map);
      map.getSource('ride-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: geom } });
    });
  }, [day.id, routes]); // eslint-disable-line react-hooks/exhaustive-deps

  // reroute line: draw it bright, drop the planned line to a ghost underneath
  const applyLiveRef = useRef(() => {});
  applyLiveRef.current = () => {
    const map = mapRef.current;
    if (!map) return;
    ensureNavLayers(map);
    map.getSource('ride-live').setData(reroute
      ? { type: 'Feature', geometry: { type: 'LineString', coordinates: reroute.geometry } }
      : EMPTY_LINE);
    const dim = !!reroute;
    map.setPaintProperty('ride-route-line', 'line-opacity', dim ? 0.3 : 0.95);
    map.setPaintProperty('ride-route-casing', 'line-opacity', dim ? 0.2 : 0.85);
    map.setPaintProperty('ride-route-glow', 'line-opacity', dim ? 0.08 : 0.3);
    if (dim) map.setPaintProperty('ride-route-line', 'line-gradient', SOLID_AHEAD);
  };
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    whenMapReady(map, () => applyLiveRef.current());
  }, [reroute]); // eslint-disable-line react-hooks/exhaustive-deps

  // Changing the basemap calls setStyle, which drops every source and layer we
  // added — so the route has to be laid back down once the new style settles.
  const drawPlannedRef = useRef(() => {});
  drawPlannedRef.current = () => {
    const map = mapRef.current;
    if (!map) return;
    ensureNavLayers(map);
    hideNativeRoadShields(map); // the new style arrived with its own set

    const geom = routes[day.id]?.geometry ?? day.waypoints.map((w) => [w.lng, w.lat]);
    map.getSource('ride-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: geom } });
    applyLiveRef.current();
  };
  const firstStyle = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    // the map is constructed with the initial style already applied
    if (firstStyle.current) { firstStyle.current = false; return undefined; }
    map.setStyle(navStyleFor(navStyle));
    const redraw = () => drawPlannedRef.current();
    map.once('styledata', redraw);
    return () => map.off('styledata', redraw);
  }, [navStyle]);

  // a new day is a fresh slate — routes, facts, voice, the lot
  useEffect(() => {
    setReroute(null);
    setRerouteFailed(false);
    offCountRef.current = 0;
    liveRouteAtRef.current = 0;
    spokenRef.current = '';
    setDest(createNav());
    setUndoSkip(null);
    setGateHidden(new Set());
    setLiveEta(null);
    onPlanRef.current = 0;
    initLatchRef.current = false;
  }, [day.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Turn-by-turn maneuvers for the selected day — keyed on the WAYPOINTS,
  // not just the day id: a stop added under a live ride (DayPanel, Copilot,
  // a sync landing) must reach the guidance chain, or nav keeps riding the
  // old route while the map wears the new marker (field-caught adding
  // Deadwood to a cabin loop day). Same signature the steps cache uses.
  const wpSig = day.waypoints
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng))
    .map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';');
  const stepsSigRef = useRef('');
  useEffect(() => {
    let dead = false;
    setSteps(null);
    const prev = stepsSigRef.current;
    const sig = `${day.id}|${wpSig}`;
    stepsSigRef.current = sig;
    routeDaySteps(day, pace).then((s) => { if (!dead) setSteps(s); }).catch(() => { if (!dead) setSteps([]); });
    // A plan edit while a live reroute is up: the live route was built for
    // the OLD stop list — re-target it from the machine's remaining stops
    // (same-day signature change only; a day switch resets the reroute).
    if (prev && prev !== sig && prev.startsWith(`${day.id}|`) && rerouteRef.current) {
      goRouteRef.current(navRemaining(syncNav(destRef.current, day.waypoints), day.waypoints));
    }
    return () => { dead = true; };
  }, [day.id, wpSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plan edits under a live ride (added stop, a sync landing, Copilot):
  // facts are keyed by waypoint id — prune the ones that left the plan.
  useEffect(() => {
    setDest((d) => syncNav(d, day.waypoints));
  }, [day.waypoints]);

  // ---- GPS watch ----
  useEffect(() => {
    if (!navigator.geolocation) { setGeoErr(t('No GPS available in this browser.')); return; }
    // Geolocation needs a secure context. Loading the dev server over a plain
    // http:// LAN address on a phone fails here with a Core Location error that
    // reads like a bug, so name the actual cause.
    if (!window.isSecureContext) {
      setGeoErr(t('Location needs a secure connection — open the app over https. A plain http address will not get a fix on a phone.'));
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const st = statsRef.current;
        const next = { lat: p.coords.latitude, lng: p.coords.longitude, at: p.timestamp, accuracy: p.coords.accuracy };
        let mph = p.coords.speed != null && !Number.isNaN(p.coords.speed) ? p.coords.speed * 2.23694 : null;
        let heading = p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : null;
        if (st.last) {
          const dtH = (next.at - st.last.at) / 3600000;
          const dMi = haversineMiles(st.last, next);
          if (mph == null && dtH > 0) mph = dMi / dtH;
          if (heading == null && dMi > 0.01) {
            heading = (Math.atan2(
              (next.lng - st.last.lng) * Math.cos((next.lat * Math.PI) / 180),
              next.lat - st.last.lat
            ) * 180) / Math.PI;
          }
          st.miles += dMi;
        }
        if (mph != null && mph < 140) st.maxMph = Math.max(st.maxMph, mph);
        st.last = next;
        setFix({ ...next, speedMph: mph, heading });
        failSince.current = null;
        setGeoErr(null);
      },
      (e) => {
        // Core Location emits POSITION_UNAVAILABLE ("kCLErrorDomain error 0")
        // routinely while acquiring — cold start, indoors, a tunnel — and it
        // recovers on its own. A red banner for that is noise, and its raw
        // message means nothing to a rider. Permission and no-GPS are real and
        // said plainly; everything else has to persist before it is reported,
        // and never replaces a fix already on screen.
        if (e.code === 1) { failSince.current = null; setGeoErr(t('Location permission denied — allow it in your browser settings to ride with the HUD.')); return; }
        if (statsRef.current.last) return; // still navigating on the last fix
        failSince.current ??= Date.now();
        if (Date.now() - failSince.current > 10000) {
          setGeoErr(t('Waiting for a GPS fix. Outdoors with a clear view of the sky is fastest.'));
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
    const tick = setInterval(() => setClock(nowMin()), 5000);
    return () => { navigator.geolocation.clearWatch(id); clearInterval(tick); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the screen awake while riding
  useEffect(() => {
    const grab = async () => {
      try { wakeRef.current = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
    };
    grab();
    const onVis = () => { if (document.visibilityState === 'visible') grab(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('visibilitychange', onVis); wakeRef.current?.release?.(); };
  }, []);

  // ---- derived readouts ----
  const activeSteps = reroute?.steps ?? steps;
  const proj = fix ? planPosition(day, tl, fix, (planCursorRef.current ??= chainCursor())) : null;
  projRef.current = proj;
  const delta = proj ? clock - proj.plannedMin : null; // + = behind plan
  // `nav` — the turn, and every mileage a rider reads — is built further down,
  // once the routed geometry has been measured: the maneuver chain can say
  // WHICH turn is next but it cannot say how far, and that was the field bug
  // (see engine/rideDistance.js).

  // What navigation actually aims for — read straight off the fact machine.
  // The projection above is DISPLAY (plan delta, mileage); it never targets.
  const remainingNav = useMemo(() => navRemaining(dest, day.waypoints), [dest, day]);

  // Reroute origin: the bike's heading rides along only when it means
  // something — a parked bike may legally depart either direction, and a
  // heading assumed from the road snap is what buys a turn-around tour.
  const navOrigin = () => ({
    lat: fix.lat, lng: fix.lng,
    ...(fixHeading(fix) != null ? { heading: fix.heading } : {}),
  });

  // One reroute path for every deliberate retarget (skip, restore, go-next).
  // Takes the remaining list explicitly — setState hasn't landed yet when the
  // caller just changed the skip set.
  const goRoute = (rem) => {
    if (!fix || !rem.length) return;
    setRerouting(true);
    lastRerouteAtRef.current = Date.now();
    routeFrom(navOrigin(), rem, pace)
      .then((r) => {
        setReroute({ ...r, byOffRoute: false });
        setRerouteFailed(false);
        offCountRef.current = 0;
        spokenRef.current = '';
      })
      .catch(() => setRerouteFailed(true))
      .finally(() => setRerouting(false));
  };
  const goRouteRef = useRef(goRoute);
  goRouteRef.current = goRoute;

  // ---- late-start latch ----
  // Opening Ride Mode after the group has already left gives the session no
  // memory of the stops behind the bike — the projection alone can then aim
  // nav BACK at a stop everyone rode away from before the app opened. On the
  // first usable fix, walk the planned routed line once and latch every stop
  // whose position along it is clearly behind the bike.
  useEffect(() => {
    if (initLatchRef.current || !fix) return;
    if (fix.accuracy != null && fix.accuracy > 200) return; // wait for a real fix
    const coords = routes[day.id]?.geometry;
    if (!coords || routes[day.id]?.fallback || reroute || coords.length < 2) return;
    const chain = coords.map(([lng, lat]) => ({ lat, lng }));
    const cum = [0];
    for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));
    // At a point the chain visits twice the projection is ambiguous — and a
    // loop can ride the same stretch the same DIRECTION twice, so heading
    // alone can't always break the tie. Take the EARLIEST heading-compatible
    // copy: under-latching is recoverable (Go next), while a late-copy read
    // here marks the whole day visited and eats every stop.
    const bike = projectOnChainDirected(chain, fix, { heading: fixHeading(fix), cum, afterMi: 0 });
    initLatchRef.current = true;
    if (!bike || bike.off > 2) return; // far off the plan — off-route handles it
    const bikeAt = bike.along;
    // contiguous prefix only: the first stop that reads "ahead" ends the walk,
    // which also keeps out-and-back double-passage geometry from over-latching.
    // Each stop reads at its FIRST drive-by (afterMi: 0) — a stop is behind
    // only when the bike is past even its earliest approach.
    let latch = 0;
    for (let i = 1; i < day.waypoints.length - 1; i++) {
      const p = projectOnChainDirected(chain, day.waypoints[i], { cum, afterMi: 0 });
      if (p && p.along < bikeAt - 0.3) latch = i;
      else break;
    }
    if (latch > 0) {
      const behind = day.waypoints.slice(1, latch + 1).map((w) => w.id);
      setDest((d) => navInitVisited(d, day.waypoints, behind));
    }
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // the undo chip earns its place for a minute, then stands down
  useEffect(() => {
    if (!undoSkip) return undefined;
    const id = setTimeout(() => setUndoSkip(null), 60_000);
    return () => clearTimeout(id);
  }, [undoSkip]);

  // ---- posted speed limit for the road under the bike ----
  // No per-fix dead flag here: an Overpass fetch takes longer than one GPS
  // interval, and discarding its late resolution (while the tracker had
  // already latched the value internally) left the sign blank for the whole
  // way. The tracker serializes itself — whatever resolves is current truth.
  useEffect(() => {
    if (!fix) return;
    limiterRef.current ??= speedLimitTracker();
    limiterRef.current.update(fix).then((v) => {
      if (mountedRef.current && v !== undefined) setLimit(v);
    });
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // Off-route is measured against the real routed geometry, not the maneuver
  // chain (which cuts corners between turns on winding roads).
  const hasRealRoute = !!(reroute || (routes[day.id]?.geometry && !routes[day.id]?.fallback));
  const geomInfo = useMemo(() => {
    const coords = reroute?.geometry ?? routes[day.id]?.geometry ?? day.waypoints.map((w) => [w.lng, w.lat]);
    const chain = coords.map(([lng, lat]) => ({ lat, lng }));
    const cum = [0];
    for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));
    // ...and the same chain measured in the metric the map paints gradients
    // in (mercatorCum) — ground miles for every reading a rider sees, the
    // projected length for anything handed to line-progress.
    return { chain, cum, total: cum[cum.length - 1] || 1, ...mercatorCum(chain) };
  }, [reroute, routes, day]);
  const geoProj = useMemo(
    () => (fix && geomInfo.chain.length > 1
      ? (geoCursorRef.current ??= chainCursor())
        .project(geomInfo.chain, fix, { heading: fixHeading(fix), cum: geomInfo.cum })
      : null),
    [fix, geomInfo] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- how far, measured on the road ----
  // Every mileage on this screen used to come from projecting the bike onto
  // the MANEUVER chain — turn points with a straight chord between them. On an
  // interstate that is one chord a hundred miles long standing for a road that
  // bends fifteen miles off it, and the readout inherits the error directly:
  // it runs fast where the road agrees with the chord and STOPS where the road
  // crosses it. Field report, Aug 16 2026, I-90 out of Bozeman: "it shows me
  // it's ninety three miles away, but as I'm watching the mile markers, I've
  // been stuck on ninety three miles for about two to three miles" — and the
  // same ride's screenshots show the fast half, 33 miles of readout in 22
  // minutes at an indicated 90 mph.
  //
  // So the maneuvers are pinned to the routed geometry once, and after that a
  // distance is a subtraction along the line the bike is actually riding. The
  // maneuver chain keeps what it is good at: which turn is next and what it
  // says. `locateOnSteps` stays as the fallback for a day with no real routed
  // geometry (an OSRM failure draws straight lines between stops), where there
  // is nothing better to measure against.
  const stepAlong = useMemo(
    () => (hasRealRoute ? stepAlongs(activeSteps, geomInfo) : null),
    [activeSteps, geomInfo, hasRealRoute]
  );
  const nav = !fix || !activeSteps?.length ? null
    : (stepAlong && geoProj
      ? navAlongRoute(activeSteps, stepAlong, geoProj.along, geomInfo.total, geoProj.off)
      : locateOnSteps(activeSteps, fix, (stepsCursorRef.current ??= chainCursor())));

  // ---- ONE highway shield on the road ahead ----
  // The route line's glow, casing and core paint over the shields the
  // satellite tiles carry, so the nav map showed where you were going while
  // hiding what road you were on. This puts the number back — and puts back
  // exactly one of it. Shields went into Ride unbounded first and came
  // straight out again ("take road markers off ride mode"); the ask on the
  // way back in was that they not be overbearing, so RouteShields draws a
  // single sign (max 1) carrying a single number (perSign 1), standing on the
  // road a few hundred yards ahead and sliding past as it is ridden. The turn
  // card still names the road you are turning ONTO; this names the one you
  // are on.
  //
  // Quantized to the quarter mile: without it the ladder is a new array every
  // GPS fix and the marker churns once a second.
  const aheadMi = geoProj ? Math.round(geoProj.along * 4) / 4 : null;
  const shieldMarks = useMemo(() => {
    const src = reroute?.steps ?? steps;
    if (!src?.length || !hasRealRoute || geomInfo.chain.length < 2) return [];
    return shieldPlacements(src, geomInfo.chain, { cum: geomInfo.cum, aheadMi });
  }, [steps, reroute, geomInfo, hasRealRoute, aheadMi]);

  const goodFix = fix && (fix.accuracy == null || fix.accuracy < 200);
  const offRoute = !!(geoProj && goodFix && geoProj.off > (hasRealRoute ? 0.12 : 2.5));

  // ---- destination engine: one event per usable GPS fix ----
  // onRoute suppresses the pass-by auto-skip: on a winding approach the
  // straight-line distance to the target GROWS while the road is taking you
  // there (Hwy 244 to Mount Rushmore) — the road's shape is not a change of
  // intent. Off the route, pulling away past closest approach still skips.
  useEffect(() => {
    if (!fix || !goodFix) return;
    const onRoute = hasRealRoute && !offRoute;
    // Along-route passage: is the bike past the route's closest point to the
    // current target? Monotonic as you ride — switchbacks can't fake it —
    // and it resolves targets whose pin sits off the road (never inside the
    // arrival ring). 0.3 mi of buffer absorbs snap noise.
    let passedTargetId = null;
    const tgt = navTarget(destRef.current, day.waypoints);
    // Passage is a RIDING phenomenon: it needs a moving fix whose projection
    // agrees with the bike's heading. A parked bike can't pass anything, and
    // a heading-opposed match means the projection is on the wrong copy of
    // an out-and-back road — neither may resolve a stop.
    if (onRoute && tgt && geoProj && geomInfo.chain.length > 1
      && fixHeading(fix) != null && geoProj.aligned !== false) {
      // The route may approach this stop more than once (out-and-back).
      // Measure passage against its NEXT approach at-or-past the bike —
      // projecting onto an earlier drive-by would read "passed" the moment
      // the stop became the target.
      const tp = projectOnChainDirected(geomInfo.chain, tgt, {
        cum: geomInfo.cum, afterMi: geoProj.along - 0.3,
      });
      if (tp && tp.off < 0.5 && geoProj.along > tp.along + 0.3) passedTargetId = tgt.id;
    }
    const { nav: next, events } = navFix(destRef.current, day.waypoints, fix, { onRoute, passedTargetId });
    if (next !== destRef.current) {
      destRef.current = next;
      setDest(next);
    }
    for (const ev of events) {
      if (ev.type === 'autoskip') {
        setUndoSkip({ id: ev.id, name: ev.name });
        speak(`Passing ${ev.name}. Skipping it — tap undo to go back.`);
        goRouteRef.current(navRemaining(next, day.waypoints));
      } else if (ev.type === 'arrive') {
        setUndoSkip((u) => (u?.id === ev.id ? null : u));
      }
    }
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weather for a point up the road rather than underfoot — what matters on a
  // bike is what you are about to ride into. Keyed to a coarse grid in
  // conditions.js so travelling along a road reuses one cache entry.
  const aheadPt = useMemo(() => {
    const chain = geomInfo?.chain;
    if (!chain?.length || !geoProj) return null;
    // ~12 miles ahead along the routed line. Walk from the ROUTED-GEOMETRY
    // vertex under the bike (geoProj) — proj.i indexes the waypoint chain,
    // and using it here pinned "ahead" a few vertices past the day's start.
    const startIdx = Math.min(chain.length - 1, Math.max(0, geoProj.i));
    let acc = 0;
    for (let i = startIdx; i < chain.length - 1; i++) {
      acc += haversineMiles(chain[i], chain[i + 1]);
      if (acc >= 12) return chain[i + 1];
    }
    return chain[chain.length - 1];
  }, [geomInfo, geoProj?.i]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!aheadPt) return;
    let dead = false;
    fetchConditionsAhead(aheadPt.lat, aheadPt.lng).then((w) => { if (!dead && w) setAhead(w); });
    return () => { dead = true; };
  }, [aheadPt?.lat?.toFixed?.(1), aheadPt?.lng?.toFixed?.(1)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Three-zone route line: dim gray BEHIND the bike (traveled), full-bright
  // to the NEXT STOP, muted amber for the rest of the day. On a loop-heavy
  // day the whole remaining route in full orange reads as spaghetti — the
  // leg being ridden should be the one bright thing (field screenshot,
  // Deadwood → Needles with the day's web all highlighted).
  useEffect(() => {
    const map = mapRef.current;
    const layer = reroute ? 'ride-live-line' : 'ride-route-line';
    // Gate on the LAYER, never on isStyleLoaded(): the style reads "not
    // loaded" while tiles stream, so a moving bike almost never satisfied it
    // and the split FROZE where it was first painted while the rider kept
    // going — the field report's "keeps getting further from my marker".
    // Repainting one layer's gradient needs that layer and nothing else.
    if (!map || !map.getLayer(layer)) return;
    let frac = 0;
    let legFrac = null;
    if (geoProj && !offRoute) {
      // Gradient stops are line-progress, which is a MERCATOR fraction of the
      // line — a ground-mile fraction lands further and further from the bike
      // the deeper into a north–south day it is measured (see lineProgressAt).
      frac = lineProgressAt(geomInfo, geoProj.i, geoProj.f) ?? 0;
      // the next stop's position along the route — its NEXT approach at-or-
      // past the bike, same measure passedTargetId trusts
      const tgt = navRemaining(destRef.current, day.waypoints)[0];
      if (tgt) {
        const tp = projectOnChainDirected(geomInfo.chain, tgt, {
          cum: geomInfo.cum, afterMi: geoProj.along - 0.3,
        });
        const lp = tp && tp.off < 2 ? lineProgressAt(geomInfo, tp.i, tp.f) : null;
        if (lp != null) legFrac = Math.min(0.999, lp);
      }
    }
    frac = Math.max(0, Math.min(0.999, frac));
    const stops = [];
    if (frac > 0.001) stops.push(frac, NAV_AHEAD);
    if (legFrac != null && legFrac > frac + 0.003) stops.push(legFrac, NAV_BEYOND);
    map.setPaintProperty(layer, 'line-gradient',
      stops.length === 0 ? SOLID_AHEAD
        : ['step', ['line-progress'], frac > 0.001 ? NAV_DONE : NAV_AHEAD, ...stops]);
  }, [geoProj, reroute, offRoute, dest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- puck + chase camera, map-matched ----
  // Within ~30 m of the line the puck snaps onto it and takes the road's
  // bearing instead of the GPS one — kills the wobble like the big nav apps.
  // Between 1 Hz fixes the puck GLIDES to the new position on animation
  // frames instead of hopping once a second — the hop is what made tracking
  // feel a beat behind the bike.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fix) return undefined;
    // Live positioning claims the camera: the FIRST fix of a ride turns
    // follow back on — pre-ride peeking (overview, a stop-card fly-to) used
    // to leave departure on a stale frame demanding a RE-CENTER tap (field
    // complaint). And riding away from any later peek self-heals after a
    // grace period, Google-style; a parked rider studying the map is left
    // alone (speed gate).
    if (!hadFixRef.current) {
      hadFixRef.current = true;
      if (!followRef.current) { followRef.current = true; setFollow(true); }
    } else if (!followRef.current && (fix.speedMph ?? 0) >= 8
        && Date.now() - lastTouchRef.current > ZOOM_HOLD_MS) {
      followRef.current = true;
      setFollow(true);
    }
    const SNAP_MI = 0.019; // ≈ 30 m
    let lat = fix.lat, lng = fix.lng, heading = fix.heading;
    const a = geoProj && geomInfo.chain[geoProj.i];
    const b = geoProj && geomInfo.chain[geoProj.i + 1];
    if (geoProj && geoProj.off < SNAP_MI && a && b) {
      lat = a.lat + geoProj.f * (b.lat - a.lat);
      lng = a.lng + geoProj.f * (b.lng - a.lng);
      if (fix.speedMph == null || fix.speedMph > 3) {
        heading = (Math.atan2((b.lng - a.lng) * Math.cos((lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI;
      }
    }
    const from = puckPosRef.current;
    const to = { lat, lng, heading: heading ?? from?.heading ?? 0 };
    cancelAnimationFrame(puckAnimRef.current);
    // teleports (first fix, sim jumps, tunnels) place directly — no glide
    if (!from || haversineMiles(from, to) > 0.5) {
      puckPosRef.current = to;
      puckRef.current?.setLngLat([to.lng, to.lat]);
      if (heading != null) puckRef.current?.setRotation(to.heading);
    } else {
      const t0 = performance.now();
      const dur = 850; // ≈ one GPS interval
      const dh = ((to.heading - from.heading + 540) % 360) - 180; // shortest arc
      const stepAnim = (now) => {
        const k = Math.min(1, (now - t0) / dur);
        const cur = {
          lat: from.lat + (to.lat - from.lat) * k,
          lng: from.lng + (to.lng - from.lng) * k,
          heading: from.heading + dh * k,
        };
        puckPosRef.current = cur;
        puckRef.current?.setLngLat([cur.lng, cur.lat]);
        if (heading != null) puckRef.current?.setRotation(cur.heading);
        if (k < 1) puckAnimRef.current = requestAnimationFrame(stepAnim);
      };
      puckAnimRef.current = requestAnimationFrame(stepAnim);
    }
    if (followRef.current) {
      // Zoom breathes with speed (continuous — see speedZoom) and tightens
      // into the next turn. A fresh pinch hold wins outright, turn tighten
      // included: the rider who pinched out to see the road ahead meant it.
      const hold = zoomHoldRef.current;
      const held = hold != null && Date.now() - hold.at < ZOOM_HOLD_MS;
      if (hold && !held) zoomHoldRef.current = null;
      let zoom = held ? hold.z : speedZoom(fix.speedMph);
      if (!held && nav && nav.toNext < 0.35) zoom = Math.max(zoom, 16.5);
      const northUp = camModeRef.current === 'north';
      map.easeTo({
        center: [lng, lat],
        // north-up holds the map still and lets the puck arrow carry the
        // heading — the Google grammar for the flat overhead view
        bearing: northUp ? 0 : heading ?? map.getBearing(),
        pitch: northUp ? 0 : 55,
        zoom,
        duration: 900,
        // LINEAR: consecutive 1 Hz eases chain into continuous motion —
        // the default s-curve decelerated into every fix and read as lag
        easing: (t) => t,
        // keep the puck low on screen so the road ahead fills the view
        padding: { top: Math.round((mapDivRef.current?.clientHeight ?? 600) * 0.4), bottom: 0, left: 0, right: 0 },
      });
    }
    // warm the satellite/road tiles the rider is about to need
    if (geoProj && Date.now() - warmAtRef.current > 15000) {
      warmAtRef.current = Date.now();
      warmTilesAhead(geomInfo.chain, geoProj.i, { miles: 12 });
    }
    return () => cancelAnimationFrame(puckAnimRef.current);
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggling the compass snaps the camera to the new grammar immediately —
  // waiting for the next GPS fix would make the button feel dead.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({
      bearing: camMode === 'north' ? 0 : fix?.heading ?? map.getBearing(),
      pitch: camMode === 'north' ? 0 : 55,
      duration: 450,
    });
  }, [camMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live rerouting: off the line for a few fixes → recalc from here ----
  useEffect(() => {
    // Decay rather than reset: skimming the 0.12 mi line must not stall the trigger.
    if (!fix || !offRoute) { offCountRef.current = Math.max(0, offCountRef.current - 1); return; }
    offCountRef.current += 1;
    if (offCountRef.current < 3) return;
    const now = Date.now();
    if (reroutingRef.current || now - lastRerouteAtRef.current < 20000) return;
    const remaining = remainingNav; // latched + skip-aware, never a passed stop
    if (!remaining.length) return;
    setRerouting(true);
    lastRerouteAtRef.current = now;
    speak('Off route. Recalculating.');
    routeFrom(navOrigin(), remaining, pace)
      .then((r) => {
        setReroute({ ...r, byOffRoute: true });
        setRerouteFailed(false);
        offCountRef.current = 0;
        spokenRef.current = '';
        speak(`New route. ${r.steps[1]?.instr ?? ''}`);
      })
      .catch(() => setRerouteFailed(true))
      .finally(() => setRerouting(false));
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // back on the original plan → drop an off-route detour (traffic-anchored
  // live routes stay — they refresh on their own cadence below)
  useEffect(() => {
    if (!reroute?.byOffRoute || !fix) { onPlanRef.current = 0; return; }
    const coords = routes[day.id]?.geometry;
    if (!coords) return;
    const p = projectOnChain(coords.map(([lng, lat]) => ({ lat, lng })), fix);
    // Several consecutive on-plan fixes — a detour that merely CROSSES the
    // planned line must not kill the live route. And while stops are skipped
    // (or nav is heading back to a restored one) the planned steps would
    // route straight through them, so the skip-aware live route stays up.
    if (p && p.off < 0.08) {
      onPlanRef.current += 1;
      if (onPlanRef.current >= 3 && destRef.current.skipped.size === 0 && !destRef.current.pinned) {
        setReroute(null);
        setRerouteFailed(false);
        onPlanRef.current = 0;
      }
    } else onPlanRef.current = 0;
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // A deliberate reroute (skip/restore/go-next) that failed — no signal in a
  // canyon — must retry: until it lands, the old steps still voice-guide the
  // rider toward a stop they dropped.
  useEffect(() => {
    if (!fix || !rerouteFailed || rerouting) return;
    if (!dest.skipped.size && !dest.pinned) return;
    if (Date.now() - lastRerouteAtRef.current < 20000) return;
    goRoute(remainingNav);
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- traffic anchor: live-traffic ETA, and ONLY the ETA ----
  // Every 10 min, fetch a traffic-aware route from the bike through the
  // remaining stops and keep its total time. The GEOMETRY is deliberately
  // never adopted: a time-optimizer will happily touch a mid-pass stop and
  // double back around the mountain, and the planned road is the point of
  // the ride. The route line only ever changes when the rider goes off-route
  // or explicitly retargets (skip / go next / restore).
  useEffect(() => {
    if (!fix || !goodFix || !proj || offRoute || reroutingRef.current) return;
    const now = Date.now();
    if (now - liveRouteAtRef.current < 10 * 60_000) return;
    liveRouteAtRef.current = now;
    const remaining = remainingNav; // latched + skip-aware
    if (!remaining.length) return;
    routeFrom(navOrigin(), remaining, pace)
      .then((r) => { if (r.traffic) setLiveEta({ min: r.seconds / 60, at: Date.now() }); })
      .catch(() => { /* next cycle retries */ });
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

  // The next stop nav is actually taking you to — latched and skip-aware.
  const nextWp = fix ? remainingNav[0] ?? null : null;
  const nextWpIdx = nextWp ? day.waypoints.indexOf(nextWp) : -1;
  // Before a fix, "next" is simply the plan's first destination.
  const plannedNext = fix ? null : (day.waypoints[1] ?? day.waypoints[0]);
  const nextSched = nextWpIdx >= 0 ? tl.stops[nextWpIdx] : null;
  const projectedEnd = delta != null ? tl.endMin + delta : null;
  // Day-end ETA, and the CURRENT LEG's numbers — the leg is the primary
  // readout: how much longer to the next stop, and the clock time you get there.
  // Steps carry riding time only, so the planned time-on-the-ground at stops
  // still ahead rides along — without it the day-end ETA reads ~half an hour
  // optimistic on a day with fuel and photo stops left.
  const remDwellMin = useMemo(() => tl.stops.reduce((a, s, i) => {
    const w = day.waypoints[i];
    if (!w || i === 0 || dest.visited.has(w.id) || dest.skipped.has(w.id)) return a;
    return a + (s.dwell ?? 0);
  }, 0), [tl, day, dest]);
  // Traffic-aware total when fresh (the anchor refreshes it every 10 min),
  // decayed by the minutes since it was measured; while a reroute is active
  // the stored figure describes a route no longer being ridden, so it stands
  // down until the next anchor cycle.
  const liveRemMin = liveEta && !reroute && Date.now() - liveEta.at < 12 * 60_000
    ? Math.max(0, liveEta.min - (Date.now() - liveEta.at) / 60_000)
    : null;
  const eta = nav ? clock + (liveRemMin ?? nav.remMin) + remDwellMin : null;
  const legRemMin = nav ? nav.legMin
    : nextSched && delta != null ? Math.max(0, nextSched.arrive + delta - clock) : null;
  const legMiles = nav ? nav.legMi : proj?.remainToNext ?? null;
  const legEta = legRemMin != null ? clock + legRemMin : null;

  // voice guidance at 1 mi / ¼ mi / on the turn. Muted while a deliberate
  // reroute is in flight — until the new steps land, the old ones describe a
  // destination the rider just dropped, and speaking them is the split-brain
  // ("the bar says Rushmore, the voice says the cabin") made audible.
  useEffect(() => {
    if (!nav || !nav.next || offRoute || rerouting) return;
    // Pick the CLOSEST tier already crossed. The old loop broke on the first
    // (largest) match, so once inside a mile only "In one mile" could ever
    // fire — the quarter-mile and on-turn calls were unreachable.
    const tiers = [[1.05, 'In one mile, '], [0.27, 'In a quarter mile, '], [0.1, '']];
    let hit = null;
    for (const t of tiers) if (nav.toNext <= t[0]) hit = t;
    if (!hit) return;
    const key = `${nav.idx}:${hit[0]}`;
    if (spokenRef.current !== key) {
      spokenRef.current = key;
      speak(hit[1] + nav.next.instr);
    }
  }, [nav?.idx, nav?.toNext, offRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  const gateReads = (day.gates ?? []).map((g) => {
    const s = tl.stops.find((x) => x.id === g.waypointId);
    if (!s) return null;
    const projected = delta != null ? s.arrive + delta : s.arrive;
    return { label: g.label, by: g.by, projected, ok: projected <= parseTime(g.by) };
  }).filter(Boolean);

  // Minimalist drops the word: a signed figure in green or red says early or
  // late without spending a line on saying it, and it needs no translating.
  // Signed and colored at every density: the word LATE cost the chip enough
  // width to wrap the whole first row on a phone — a third bar row of lost
  // map. Red +, green −, rally ±0 carry the same message in half the space.
  const deltaChip = delta == null ? null : Math.abs(delta) < 5
    ? { cls: 'on-time', text: '±0' }
    : delta > 0
      ? { cls: 'behind', text: `+${fmtDur(delta)}` }
      : { cls: 'ahead', text: `−${fmtDur(-delta)}` };

  // "Behind" on its own is not actionable. This is where the plan says you
  // should be at this minute — which leg, and how far off in ground terms —
  // read straight off the timeline, so moving a stop or retiming a departure
  // changes it with nothing to invalidate.
  const target = proj ? planTargetAt(day, tl, clock) : null;
  const targetWp = target ? day.waypoints[target.stopIndex] : null;
  const milesOff = target && proj ? proj.doneMiles - target.miles : null;

  // ---- the numbers Google Maps cannot show ----
  // Miles of road to the next fuel stop — read off the plan, colored against
  // the bike's own range. THE moto-specific number.
  const range = tripRange(trip);
  const nextFuel = useMemo(() => {
    if (!proj) return null;
    let mi = proj.remainToNext;
    for (let j = proj.i + 1; j < day.waypoints.length; j++) {
      // a skipped or already-visited fuel stop is fuel you are NOT getting
      const w = day.waypoints[j];
      if (w.fuel && !dest.skipped.has(w.id) && !dest.visited.has(w.id)) return { name: w.name, miles: mi };
      mi += tl.stops[j + 1]?.legMiles ?? 0;
    }
    return null;
  }, [proj?.i, proj?.remainToNext, day, tl, dest]); // eslint-disable-line react-hooks/exhaustive-deps

  // The next gate still ahead of the bike, with its live margin. One gate,
  // big — a row of tiny chips at 70 mph is decoration, not information.
  const nextGate = useMemo(() => {
    if (!fix) return null;
    for (const g of day.gates ?? []) {
      const idx = day.waypoints.findIndex((w) => w.id === g.waypointId);
      if (idx < 0 || (proj && idx <= proj.i) || dest.skipped.has(g.waypointId) || dest.visited.has(g.waypointId)) continue;
      const s = tl.stops[idx];
      if (!s) continue;
      const projected = delta != null ? s.arrive + delta : s.arrive;
      const margin = parseTime(g.by) - projected;
      return { id: g.waypointId, label: g.label, by: g.by, margin, ok: margin >= 0 };
    }
    return null;
  }, [fix, day, tl, delta, proj?.i, dest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Day's end: the machine says the final stop is what's left, and the bike
  // is within a couple hundred yards of it — a tighter couple at riding
  // speed, so the arrival card can't swap in while still genuinely riding.
  const lastWp = day.waypoints[day.waypoints.length - 1];
  const arrived = !!(fix && lastWp
    && navTarget(dest, day.waypoints)?.id === lastWp.id
    && haversineMiles(fix, lastWp) < ((fix.speedMph ?? 0) > PARK_MPH ? 0.08 : 0.15));

  // The remaining stops as swipeable cards — the roadbook strip. Google gives
  // you turns; a roadbook gives you the day. Skipped stops stay visible
  // (dimmed, restorable) — hiding them would make Restore undiscoverable.
  // Visited stops drop off; unvisited ones stay listed however the GPS reads.
  const stopsAhead = useMemo(() => day.waypoints
    .map((w, i) => ({ w, i, s: tl.stops[i] }))
    .filter(({ w, i }) => i > 0 && !dest.visited.has(w.id))
    .map(({ w, i, s }) => ({
      id: w.id, name: w.name, fuel: !!w.fuel, kind: w.kind,
      dwell: s?.dwell ?? 0,
      arrive: s ? (delta != null ? s.arrive + delta : s.arrive) : null,
      lat: w.lat, lng: w.lng,
      skipped: dest.skipped.has(w.id),
      isLast: i === day.waypoints.length - 1,
    })), [day, tl, dest, delta]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deliberate destination control from the sheet — each verb is one machine
  // declaration, then the route re-fetches for the machine's remaining list.
  // Facts can't be dissolved by anything the GPS does afterward.
  const applyDest = (next) => {
    destRef.current = next;
    setDest(next);
    goRoute(navRemaining(next, day.waypoints));
  };
  const skipStop = (id) => {
    if (undoSkip?.id === id) setUndoSkip(null);
    applyDest(navSkip(destRef.current, day.waypoints, id));
  };
  const restoreStop = (id) => {
    if (undoSkip?.id === id) setUndoSkip(null);
    applyDest(navRestore(destRef.current, id));
  };
  const goNextStop = (id) => {
    const w = day.waypoints.find((x) => x.id === id);
    if (!w) return;
    setUndoSkip(null);
    setSheetOpen(false);
    setFollow(true);
    // Standing at the stop already? That's an ARRIVAL declaration, not a
    // routing request — routing to a pin you're on top of yields a legal
    // loop of the venue's one-ways (field-caught at Mount Rushmore: 4 road
    // miles to a stop 550 feet away). Slightly wider than the latch ring:
    // venue pins sit past the parking the bike actually stands in.
    if (fix && haversineMiles(fix, w) < 0.3 && day.waypoints[day.waypoints.length - 1]?.id !== id) {
      // same declaration as any Go next (everything before is behind me),
      // plus: this stop is REACHED, aim onward
      const next = navArriveAt(navGoNext(destRef.current, day.waypoints, id), day.waypoints, id);
      destRef.current = next;
      setDest(next);
      const onward = navRemaining(next, day.waypoints);
      speak(`You're at ${w.name}.${onward[0] ? ` Next: ${onward[0].name}.` : ''}`);
      goRoute(onward);
      return;
    }
    speak(`Navigating to ${w.name}.`);
    applyDest(navGoNext(destRef.current, day.waypoints, id));
  };
  const undoLastSkip = () => {
    if (!undoSkip) return;
    const { id, name } = undoSkip;
    speak(`Heading back to ${name}.`);
    setUndoSkip(null);
    applyDest(navRestore(destRef.current, id));
  };

  // ---- add a stop mid-ride: gas, food, a place — into the current leg ----
  useEffect(() => {
    if (q.trim().length < 3) { setFound(null); setSearching(false); return undefined; }
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const near = fix ?? nextWp ?? day.waypoints[0];
        setFound(await geocode(q.trim(), near ? { lat: near.lat, lng: near.lng } : undefined));
      } catch {
        setFound([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(id);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const addStop = (r, fuel) => {
    // Insert where it geographically belongs among the REMAINING stops,
    // anchored at the bike: a station between here and the next stop lands on
    // this leg, a pick further up the day slots in later — blindly inserting
    // "next" would make the route double back for anything past the next stop.
    const rem = navRemaining(destRef.current, day.waypoints);
    const anchor = fix ? { lat: fix.lat, lng: fix.lng } : day.waypoints[0];
    const tail = [anchor, ...rem];
    const pos = Math.max(1, bestInsertIndex(tail, r)); // slot within [anchor, ...rem]
    // day-array index: before the remaining stop this pick precedes, or the end
    const before = rem[pos - 1];
    const at = before ? day.waypoints.findIndex((w) => w.id === before.id) : day.waypoints.length;
    const wp = {
      name: r.name, lat: r.lat, lng: r.lng,
      kind: fuel ? 'fuel' : 'via',
      ...(fuel ? { fuel: true } : {}),
      // straight out of the live places database — proved on arrival
      ...(r.source === 'google' && r.id ? { placeId: r.id, verified: 'google' } : {}),
    };
    dispatch({ type: 'apply_ops', ops: [{ op: 'add_waypoint', dayId: day.id, index: at, waypoint: wp }] });
    setQ('');
    setFound(null);
    setSheetOpen(false);
    setFollow(true);
    speak(`Added ${r.name}. Rerouting.`);
    if (fix) {
      goRoute([...rem.slice(0, pos - 1), wp, ...rem.slice(pos - 1)]);
    }
  };

  // Stops placed along the progress bar by their share of the day's distance, so
  // the bar shows what is coming (fuel, a photo stop, the end) and not just how
  // far along you are.
  const stopMarks = useMemo(() => {
    if (!totalMiles) return [];
    // Meals are day-level, not waypoint-level, so a stop counts as a meal when a
    // meal's venue name turns up in it — "Our Place (breakfast)" and the like.
    const mealNames = (day.meals ?? [])
      .map((m) => (m.name || '').toLowerCase().replace(/\s*\(.*$/, '').trim())
      .filter((n) => n.length > 3);
    let acc = 0;
    return tl.stops.map((st, i) => {
      acc += st.legMiles;
      const w = day.waypoints[i];
      if (!w) return null;
      const lower = (w.name || '').toLowerCase();
      // A stop is often more than one thing — breakfast at Our Place is also the
      // fuel top-off next door — so these are flags, not a single category.
      const isFuel = !!w.fuel;
      const isMeal = mealNames.some((n) => lower.includes(n));
      const isPhoto = w.kind === 'photo';
      const isEnd = w.kind === 'end' || w.kind === 'start';
      const letter = `${isFuel ? 'F' : ''}${isMeal ? 'M' : ''}${isPhoto ? 'P' : ''}`;
      // the dot takes the most safety-critical of them
      const kind = isFuel ? 'fuel' : isMeal ? 'meal' : isPhoto ? 'photo' : isEnd ? 'end' : 'via';
      // a via with real time on the ground is worth marking; a pass-through is not
      const minor = kind === 'via' && !(st.dwell > 0);
      return {
        pct: Math.max(0, Math.min(100, (acc / totalMiles) * 100)),
        kind, letter, name: w.name, note: w.note || '', miles: acc,
        arrive: st.arrive, minor,
      };
    }).filter(Boolean);
  }, [tl, day, totalMiles]);


  const showOverview = () => {
    lastTouchRef.current = Date.now(); // a full grace period before auto-recenter
    setFollow(false);
    const map = mapRef.current;
    if (!map) return;
    const coords = reroute?.geometry ?? routes[day.id]?.geometry ?? day.waypoints.map((w) => [w.lng, w.lat]);
    if (coords.length < 2) return;
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.setPitch(0);
    // Padding leaves room for the HUD, which covers the top and bottom of the
    // screen — without it the first and last stops sit under the panels.
    map.fitBounds(b, {
      bearing: 0,
      duration: 800,
      padding: { top: 120, bottom: 190, left: 60, right: 60 },
    });
  };

  // Named stops, always on the map — a rider closing on a diner needs to SEE
  // the diner without zooming out to the overview. The dots are small and the
  // labels ride the map, so at nav zoom they read as destinations, not noise.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    wpMarkersRef.current.forEach((m) => m.remove());
    wpMarkersRef.current = [];

    const marks = [];
    day.waypoints.forEach((w, i) => {
      if (!Number.isFinite(w.lat) || !Number.isFinite(w.lng)) return;
      const mark = stopMarks.find((m) => m.name === w.name);
      const el = document.createElement('div');
      el.className = `ov-wp ${mark?.kind ?? 'via'}`;
      const dot = document.createElement('span');
      dot.className = 'ov-dot';
      const label = document.createElement('span');
      label.className = 'ov-label';
      label.textContent = tt(w.name);
      // alternate sides so consecutive labels along a line do not stack
      el.classList.add(i % 2 ? 'below' : 'above');
      el.append(dot, label);
      marks.push({ el, label, ll: [w.lng, w.lat] });
      wpMarkersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([w.lng, w.lat]).addTo(map));
    });

    // A stop that is not on screen has no business being drawn. MapLibre parks
    // its marker off in the margins rather than removing it, and a pitched nav
    // camera folds ground beyond the horizon back into the top of the frame —
    // so "off screen" is a question only viewGate can answer. Everything below
    // (the clamp especially) applies to on-screen stops ONLY.
    const cull = () => {
      const on = viewGate(map, { pad: 4 });
      let any = false;
      marks.forEach((m) => {
        m.on = !!on(m.ll);
        m.el.classList.toggle('off', !m.on);
        any = any || m.on;
      });
      return any;
    };

    // A label is centred on its stop, so a stop near the edge of the screen
    // hangs half its name off it — the first and last stop of a day, every
    // time. Slide those back inside instead of letting them get cut.
    //
    // Only the ON-SCREEN ones. Clamping by measured rectangle alone is what
    // fired stop names across the screen every second of a ride (field report,
    // Aug 15 2026): a stop 200 miles up the trip measures at x = -700000px, so
    // the "slide it back inside" nudge is +700006px, and the whole rest of the
    // day piled onto the left edge — re-thrown on every camera settle, which
    // under a chase camera is once a second, forever.
    const clamp = () => {
      const box = map.getContainer().getBoundingClientRect();
      marks.forEach(({ label, on }) => {
        const prev = Number(label.dataset.dx || 0);
        if (!on) {
          if (prev) { label.dataset.dx = '0'; label.style.transform = ''; }
          return;
        }
        const r = label.getBoundingClientRect();
        const left = r.left - box.left - prev; // where it would sit untranslated
        const dx = left < 6 ? 6 - left
          : left + r.width > box.width - 6 ? box.width - 6 - (left + r.width)
            : 0;
        if (dx !== prev) {
          label.dataset.dx = String(dx);
          label.style.transform = dx ? `translateX(${dx}px)` : '';
        }
      });
    };
    // Clamp only when the map SETTLES. Re-translating labels on every move
    // frame made them drift away from their dots mid-zoom; during a gesture
    // the label stays anchored, and slides inside the viewport when it lands.
    // Culling is cheap arithmetic and carries no such hazard, so it rides
    // every frame — a stop must appear the moment it enters the frame, not a
    // second later when the camera stops.
    const unclamp = () => {
      marks.forEach(({ label }) => {
        if (label.dataset.dx) { label.dataset.dx = '0'; label.style.transform = ''; }
      });
    };
    const settle = () => { cull(); clamp(); };
    const moving = () => { cull(); unclamp(); };
    settle();
    map.on('movestart', moving);
    map.on('move', cull);
    map.on('moveend', settle);
    map.on('zoomend', settle);
    return () => {
      map.off('movestart', moving);
      map.off('move', cull);
      map.off('moveend', settle);
      map.off('zoomend', settle);
      wpMarkersRef.current.forEach((m) => m.remove());
      wpMarkersRef.current = [];
    };
  }, [day, stopMarks, tt]);

  return (
    // any first tap unlocks the speech engine (ref-guarded to run once)
    <div className="ride-mode nav" onPointerDown={unlockVoice}>
      <div ref={mapDivRef} className="ride-map" />
      {/* one sign, one number, on the road ahead */}
      <RouteShields map={mapObj} placements={shieldMarks} avoid={day.waypoints} max={1} perSign={1} mode="ride" />

      {/* ---- top: the turn OWNS the top edge; weather + close ride beneath
              it on the right ---- */}
      <div className="ride-overlay ride-overlay-top">
        {/* the sheet is a menu — while it is up, the turn card and the map
            fabs stand down so it isn't buried under HUD on short screens */}
        {nav && !offRoute && !arrived && !sheetOpen && (
          <div className="turn-card">
            <LaneStrip lanes={nav.next.lanes} />
            <div className="turn-head">
              <div className="turn-icon"><TurnArrow step={nav.next} /></div>
              <div className="turn-body">
                <div className="t-dist">
                  <span className="t-mi">{fmtStepDist(nav.toNext)}</span>
                  {nav.next.exitNo && <span className="t-exit">{t('Exit')} {nav.next.exitNo}</span>}
                </div>
                <div className="t-instr">
                  {stepShields(nav.next).map((r) => <RoadShield key={r.key} road={r} className="t-shield" />)}
                  {nav.next.roadName || nav.next.instr}
                </div>
              </div>
            </div>
            {nav.after && (
              <div className="t-then">
                <TurnArrow step={nav.after} />
                <span>{nav.after.instr}</span>
              </div>
            )}
          </div>
        )}
        {steps === null && fix && !sheetOpen && <div className="turn-card loading"><div className="t-instr">loading turn-by-turn…</div></div>}

        <div className="ride-topbar">
          {/* No day descriptor here — the day title is free text that does not
              track route edits (drop a stop, the title still names it), and a
              label that can lie has no place on a nav HUD. Day context lives
              in the ride sheet, one tap on the bar. */}
          {ahead && !lean && (
            <div className="ride-chip wx" title={`${ahead.summary} · ${t('ahead')}`}>
              <WeatherIcon code={ahead.code} className="wxc-icon" />
              <span className="wxc-temp">{u.temp(ahead.temp)}</span>
              {/* this is the road ahead, not the air here — say so, or a rider
                  distrusts the number the moment it disagrees with their skin */}
              <i className="wxc-ahead">{t('ahead')}</i>
            </div>
          )}
          <button className="btn icon-btn ride-x" onClick={onClose} aria-label={t('End navigation')} title={t('End navigation')}>✕</button>
        </div>

        {geoErr && <div className="warning danger">⚠ {geoErr}</div>}
        {offRoute && !geoErr && (
          <div className="warning danger">
            {rerouting ? '⚠ Off route — finding a new way from here…'
              : rerouteFailed ? '⚠ Off route — reroute failed (no signal?). Head back toward the line.'
                : '⚠ Off route — recalculating…'}
          </div>
        )}
      </div>

      {/* ---- right edge: one-tap controls, glove-sized ---- */}
      {!sheetOpen && (
      <div className="ride-fabs">
        {/* the compass rose: needle shows true north, tap toggles the camera
            grammar — tilted track-up chase or flat north-up overhead */}
        <button
          className={`ride-fab compass${camMode === 'north' ? ' lit' : ''}`}
          onClick={() => setCamMode((m) => (m === 'track' ? 'north' : 'track'))}
          aria-label={camMode === 'track' ? t('North up') : t('Track up')}
          title={camMode === 'track' ? t('North up') : t('Track up')}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
            <path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2" stroke="currentColor" strokeWidth="1.2" opacity="0.45" />
            <g ref={compassRef} style={{ transformOrigin: '12px 12px', transition: 'transform 0.2s linear' }}>
              <path d="M12 4.6 L14.2 12 L9.8 12 Z" fill="var(--rally)" />
              <path d="M12 19.4 L9.8 12 L14.2 12 Z" fill="var(--ink-faint)" />
              <text x="12" y="3.4" textAnchor="middle" fontSize="4.6" fontFamily="var(--mono)" fill="currentColor">N</text>
            </g>
          </svg>
        </button>
        {/* add a destination mid-ride — opens the sheet with the search ready */}
        <button
          className="ride-fab"
          onClick={() => { setSheetOpen(true); setTimeout(() => searchRef.current?.focus(), 350); }}
          aria-label={t('Add a stop ahead')}
          title={t('Add a stop ahead')}
        >
          <svg viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="9.5" cy="9.5" r="5.6" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M13.8 13.8 L18.4 18.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>
        <button
          className={`ride-fab${muted ? ' off' : ''}`}
          onClick={() => {
            // unmuting speaks from the tap itself: audible confirmation, and
            // the gesture context unlocks the engine on the spot
            const next = !muted;
            setMuted(next);
            mutedRef.current = next;
            if (!next) { voiceReadyRef.current = true; speak('Voice guidance on.'); }
          }}
          aria-label={t('Voice')}
          title={t('Voice')}
        ><SpeakerIcon muted={muted} /></button>
        <button
          className="ride-fab"
          onClick={showOverview}
          aria-label={t('Route overview')}
          title={t('Route overview')}
        >
          <svg viewBox="0 0 22 22" aria-hidden="true"><path d="M4 15 L9 5 L13 12 L18 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="4" cy="15" r="2" fill="currentColor" /><circle cx="18" cy="6" r="2" fill="currentColor" /></svg>
        </button>
      </div>
      )}

      {/* ---- bottom: chips Google can\'t show, then ONE bar ---- */}
      <div className="ride-overlay ride-overlay-bottom">
        {/* panned away from the puck → the way back, Google's pill grammar */}
        {!follow && (
          <button className="ride-recenter" onClick={() => setFollow(true)}>
            <svg viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="3.2" fill="currentColor" /><circle cx="11" cy="11" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M11 1.5v4M11 16.5v4M1.5 11h4M16.5 11h4" stroke="currentColor" strokeWidth="1.8" /></svg>
            {t('Re-center')}
          </button>
        )}
        {/* posted limit for the road under the bike — MUTCD sign, OSM data;
            it simply hides where the road carries no mapped limit */}
        {limit && fix && !arrived && !sheetOpen && (
          <div className="speed-sign" title={limit.ref ? `${t('Speed limit')} · ${limit.ref}` : t('Speed limit')}>
            <span className="ss-word">{t('SPEED')}<br />{t('LIMIT')}</span>
            <b className="ss-num">{u.metric ? Math.round(limit.mph / 0.621371) : Math.round(limit.mph)}</b>
            {u.metric && <span className="ss-unit">km/h</span>}
          </div>
        )}
        {/* a stop was auto-skipped — one tap takes it back */}
        {undoSkip && !arrived && !sheetOpen && (
          <button className="ride-undo" onClick={undoLastSkip}>
            ↩ {t('Skipped')} {tt(undoSkip.name)} · <b>{t('UNDO')}</b>
          </button>
        )}
        {!arrived && fix && (nextFuel || nextGate) && !sheetOpen && (
          <div className="ride-chips">
            {nextFuel && (
              <span className={`m-chip fuel${nextFuel.miles > range.comfort ? ' danger' : ''}`}>
                <FuelPumpIcon />
                {u.miNum(nextFuel.miles)} {u.miUnit}
              </span>
            )}
            {nextGate && !gateHidden.has(nextGate.id) && (
              <span className={`m-chip gate${nextGate.ok ? '' : ' danger'}`}>
                <ClockIcon />
                {tt(nextGate.label)} · {nextGate.ok ? `${fmtDur(nextGate.margin)} ${t('margin')}` : `${fmtDur(-nextGate.margin)} ${t('LATE')}`}
                <button
                  className="mc-x"
                  aria-label={t('Dismiss')}
                  onClick={() => setGateHidden((s) => new Set(s).add(nextGate.id))}
                >✕</button>
              </span>
            )}
          </div>
        )}

        {arrived ? (
          <div className="ride-bar arrive">
            <div className="rb-main">
              <b className="rb-big">{t('Arrived')}</b>
              <span className="rb-mid">{tt(lastWp.name)}</span>
            </div>
            <div className="rb-sub">{u.miNum(statsRef.current.miles)} {u.miUnit} {t('ridden today')}</div>
            <button className="btn gold end-ride" onClick={onClose}>{t('End ride')}</button>
          </div>
        ) : (
          <>
            <button className={`ride-bar${sheetOpen ? ' open' : ''}`} onClick={() => setSheetOpen((v) => !v)} aria-expanded={sheetOpen}>
              <span className="rb-grip" aria-hidden="true" />
              {!fix ? (
                <>
                  <div className="rb-main">
                    <b className="rb-big">{t('WAITING FOR GPS')}</b>
                  </div>
                  <span className="rb-mid">{fmtTime(tl.stops[0]?.depart ?? 0)} · {u.mi(totalMiles)}</span>
                </>
              ) : (
                <>
                  {/* the LEG is the headline: time left rides alone with the
                      plan delta pinned right — sharing a row with the chip, a
                      long delta (+6h 39m) squeezed the leg miles into "99…"
                      (field bug). The leg ETA + miles share the middle row
                      with the small whole-day figure pinned right, so the leg
                      and day numbers still can't be confused. */}
                  <div className="rb-main">
                    <b className="rb-big">{legRemMin != null ? fmtDur(legRemMin) : '—'}</b>
                    {deltaChip && <span className={`rb-chip ${deltaChip.cls}`}>{deltaChip.text}</span>}
                  </div>
                  <div className="rb-duo">
                    <span className="rb-mid">
                      {legEta != null ? fmtTime(legEta) : '—'}
                      {legMiles != null ? ` · ${u.miNum(legMiles)} ${u.miUnit}` : ''}
                    </span>
                    {!lean && remainingNav.length > 1 && (eta ?? projectedEnd) != null && (
                      <span className="rb-day">
                        {t('Day')} {fmtTime(eta ?? projectedEnd)}
                        {nav && <span className="rb-day-mi">{` · ${u.miNum(nav.remMi)} ${u.miUnit}`}</span>}
                      </span>
                    )}
                  </div>
                </>
              )}
              {/* the footer is the next stop's alone now — full width means a
                  typical name fits still, and the marquee only runs on the
                  rare long one */}
              {(nextWp ?? plannedNext) && !sheetOpen && (
                <div className="rb-foot">
                  <Marquee className="rb-next" label={lean ? null : t('Next')} text={tt((nextWp ?? plannedNext).name)} />
                </div>
              )}
            </button>

            {sheetOpen && (
              <div className="ride-sheet" role="dialog" aria-label={t('Ride menu')}>
                <div className="sheet-block">
                  <div className="sheet-label">{t('Add a stop ahead')}</div>
                  <input
                    ref={searchRef}
                    className="ride-search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('Gas, food, a place…')}
                    enterKeyHint="search"
                    autoComplete="off"
                  />
                  {searching && <div className="rs-note">{t('Searching…')}</div>}
                  {!searching && found?.length === 0 && <div className="rs-note">{t('No matches — try adding the town name.')}</div>}
                  {found?.length > 0 && (
                    <div className="rs-results">
                      {found.slice(0, 5).map((r) => (
                        <div key={`${r.source}:${r.id}`} className="rs-row">
                          <div className="rs-name">
                            {r.name}
                            {r.detail && <span className="rs-detail">{r.detail}</span>}
                          </div>
                          <button onClick={() => addStop(r, false)}>＋ {t('Stop')}</button>
                          <button className="rs-fuel" onClick={() => addStop(r, true)}>＋ {t('FUEL')}</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {stopsAhead.length > 0 && (
                  <div className="sheet-block">
                    <div className="sheet-label">{t('Stops ahead')}</div>
                    <div className="stops-strip">
                      {stopsAhead.map((s) => (
                        <div key={s.id} className={`stop-card${s.fuel ? ' fuel' : ''}${s.skipped ? ' skipped' : ''}`}>
                          <button
                            className="sc-main"
                            onClick={() => {
                              lastTouchRef.current = Date.now(); // grace before auto-recenter
                              setFollow(false);
                              mapRef.current?.easeTo({ center: [s.lng, s.lat], zoom: 12.5, pitch: 0, duration: 600 });
                            }}
                          >
                            <span className="sc-kind">
                              {s.fuel ? <FuelPumpIcon className="sc-ic" />
                                : s.kind === 'end' ? <FlagIcon className="sc-ic" />
                                  : s.kind === 'photo' ? '◆' : '●'}
                            </span>
                            <span className="sc-name">{tt(s.name)}</span>
                            {s.skipped
                              ? <span className="sc-eta skip">{t('skipped')}</span>
                              : s.arrive != null && <span className="sc-eta">{fmtTime(s.arrive)}</span>}
                          </button>
                          {/* destination control: nav needs a fix to reroute from */}
                          {fix && (
                            <div className="sc-actions">
                              {s.skipped ? (
                                <button onClick={() => restoreStop(s.id)}>↩ {t('Restore')}</button>
                              ) : (
                                <>
                                  <button onClick={() => goNextStop(s.id)}>➤ {t('Go next')}</button>
                                  {!s.isLast && <button onClick={() => skipStop(s.id)}>✕ {t('Skip')}</button>}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="sheet-block">
                  <div className="sheet-label">{t('Days')}</div>
                  <div className="day-chips">
                    {trip.days.map((d) => (
                      <button
                        key={d.id}
                        className={`day-chip${d.id === day.id ? ' active' : ''}${d.date === today ? ' today' : ''}`}
                        onClick={() => { setDayId(d.id); setSheetOpen(false); setFollow(true); }}
                      >{d.dow} {fmtDayDate(d.date)}</button>
                    ))}
                  </div>
                </div>

                <div className="sheet-block sheet-settings">
                  <div className="rm-row">
                    <span className="rm-label">{t('Basemap')}</span>
                    <div className="rm-seg">
                      {NAV_STYLES.map((o) => (
                        <button key={o.key} className={navStyle === o.key ? 'active' : ''} onClick={() => setNavStyle(o.key)}>{t(o.label)}</button>
                      ))}
                    </div>
                  </div>
                  <div className="rm-row">
                    <span className="rm-label">{t('Density')}</span>
                    <div className="rm-seg">
                      <button className={lean ? 'active' : ''} onClick={() => set({ density: 'minimal' })}>{t('Minimalist')}</button>
                      <button className={!lean ? 'active' : ''} onClick={() => set({ density: 'detailed' })}>{t('Detailed')}</button>
                    </div>
                  </div>
                </div>

                <button className="btn end-nav" onClick={onClose}>{t('End navigation')}</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

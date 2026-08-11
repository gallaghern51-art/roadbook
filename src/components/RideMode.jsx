import React, { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { useTrip } from '../engine/store.js';
import { dayTimeline, fmtTime, fmtDur, parseTime, planTargetAt } from '../engine/timeline.js';
import { haversineMiles, tripRange, tripPace, projectOnChain, bestInsertIndex } from '../engine/tripEngine.js';
import { routeDaySteps, routeFrom } from '../engine/routing.js';
import { speedLimitTracker } from '../engine/speedLimit.js';
import { geocode } from '../engine/geocode.js';
import { STYLE_SATELLITE, STYLE_STREETS, STYLE_DARK, STYLE_LIGHT, warmTilesAhead, cachedGoogleStyle, googleStyle, GOOGLE_KEY } from '../engine/basemaps.js';
import { fmtDayDate } from '../engine/dates.js';
import { fetchConditionsAhead } from '../engine/conditions.js';
import WeatherIcon from './WeatherIcon.jsx';
import RoadShield from './RoadShield.jsx';
import { roadShields } from '../engine/roads.js';
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

// OSRM writes route refs as "I 90" or "I 90;US 191"; roadShields() reads the
// hyphenated form the trip notes use.
function stepShields(step) {
  if (!step?.road) return [];
  return roadShields(step.road.replace(/\b([A-Z]{1,2})\s+(\d)/g, '$1-$2').replace(/;/g, ' ')).slice(0, 2);
}

const fmtStepDist = (mi) => {
  if (mi >= 10) return `${Math.round(mi)} mi`;
  if (mi >= 0.19) return `${mi.toFixed(1)} mi`;
  return `${Math.max(50, Math.round((mi * 5280) / 50) * 50)} ft`;
};

// Position on the plan: leg index, planned clock minutes, miles done.
// (projectOnChain — position → best segment of a chain — lives in tripEngine.)
function planPosition(day, tl, pos) {
  const wps = day.waypoints;
  if (wps.length < 2) return null;
  const best = projectOnChain(wps, pos);
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
function locateOnSteps(steps, pos) {
  if (!steps || steps.length < 2) return null;
  const best = projectOnChain(steps, pos);
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

// Stop-latching thresholds: within ARRIVE_MI of the next stop it counts as
// visited (nav moves on and never routes back); a stop approached to within
// PASS_NEAR_MI and then left behind by PASS_AWAY_MI without touching it is
// auto-skipped — the rider chose the road over the pin, follow the rider.
const ARRIVE_MI = 0.25;
const PASS_NEAR_MI = 1.0;
const PASS_AWAY_MI = 0.35;

const NAV_AHEAD = '#ffab5c';
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
  // Destination control: stops the rider has passed (latched — nav never
  // routes back), stops they've skipped (auto or by hand), the undo chip.
  const [progIdx, setProgIdx] = useState(0);
  const [skipped, setSkipped] = useState(() => new Set());
  const [undoSkip, setUndoSkip] = useState(null); // {id, name} — last auto-skip
  const [returnToId, setReturnToId] = useState(null); // restored stop BEHIND the projection nav is heading back to
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
  const puckRef = useRef(null);
  const followRef = useRef(true);
  followRef.current = follow;
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
  const progIdxRef = useRef(0);
  progIdxRef.current = progIdx;
  const skippedRef = useRef(skipped);
  skippedRef.current = skipped;
  const returnToRef = useRef(null);
  returnToRef.current = returnToId;
  const passRef = useRef(null); // pass-by tracking for the next stop {id, min, lastD, away}
  const projRef = useRef(null);
  const limiterRef = useRef(null); // speed-limit tracker, one per ride
  const onPlanRef = useRef(0); // consecutive fixes back on the planned line
  const initLatchRef = useRef(false); // one-time late-start latch, per day session
  const puckPosRef = useRef(null); // last PAINTED puck position — glide start point
  const puckAnimRef = useRef(0);
  const mountedRef = useRef(true);
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
    if (import.meta.env.DEV) window.__rideMap = map; // console/sim debugging, dev only
    map.on('dragstart', () => setFollow(false));
    // the rose needle tracks true map north on every frame of rotation
    map.on('rotate', () => {
      if (compassRef.current) compassRef.current.style.transform = `rotate(${-map.getBearing()}deg)`;
    });

    const el = document.createElement('div');
    el.className = 'nav-puck';
    puckRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      .setLngLat(start ? [start.lng, start.lat] : [-108, 45])
      .addTo(map);

    return () => { map.remove(); mapRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // draw / update the day's planned route line on the nav map
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const geom = routes[day.id]?.geometry ?? day.waypoints.map((w) => [w.lng, w.lat]);
    const apply = () => {
      ensureNavLayers(map);
      map.getSource('ride-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: geom } });
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
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
    if (map.isStyleLoaded()) applyLiveRef.current();
    else map.once('load', () => applyLiveRef.current());
  }, [reroute]);

  // Changing the basemap calls setStyle, which drops every source and layer we
  // added — so the route has to be laid back down once the new style settles.
  const drawPlannedRef = useRef(() => {});
  drawPlannedRef.current = () => {
    const map = mapRef.current;
    if (!map) return;
    ensureNavLayers(map);
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

  // turn-by-turn maneuvers for the selected day
  useEffect(() => {
    let dead = false;
    setSteps(null);
    setReroute(null);
    setRerouteFailed(false);
    offCountRef.current = 0;
    liveRouteAtRef.current = 0;
    spokenRef.current = '';
    // a new day is a fresh slate for latched progress and skipped stops
    setProgIdx(0);
    setSkipped(new Set());
    setUndoSkip(null);
    setReturnToId(null);
    setLiveEta(null);
    passRef.current = null;
    onPlanRef.current = 0;
    initLatchRef.current = false;
    routeDaySteps(day, pace).then((s) => { if (!dead) setSteps(s); }).catch(() => { if (!dead) setSteps([]); });
    return () => { dead = true; };
  }, [day.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const proj = fix ? planPosition(day, tl, fix) : null;
  projRef.current = proj;
  const nav = fix && activeSteps?.length ? locateOnSteps(activeSteps, fix) : null;
  const delta = proj ? clock - proj.plannedMin : null; // + = behind plan

  // The rider's true position in the stop sequence: whichever is further —
  // geometric projection onto the plan, or the latched arrivals. The latch is
  // what stops nav from dragging you back to a stop you passed close by
  // without touching (projection alone can sit on the previous leg for miles).
  const effIdx = Math.max(progIdx, proj?.i ?? 0);
  // What navigation actually aims for: everything ahead, minus skipped stops.
  // A restored stop already BEHIND the projection goes back in front
  // explicitly — index math alone can never re-add it once effIdx passed it.
  const remainingNav = useMemo(() => {
    const ahead = day.waypoints.filter((w, i) => i > effIdx && !skipped.has(w.id));
    const back = returnToId ? day.waypoints.find((w) => w.id === returnToId) : null;
    return back && !ahead.some((w) => w.id === returnToId) ? [back, ...ahead] : ahead;
  }, [day, effIdx, skipped, returnToId]);

  // One reroute path for every deliberate retarget (skip, restore, go-next).
  // Takes the remaining list explicitly — setState hasn't landed yet when the
  // caller just changed the skip set.
  const goRoute = (rem) => {
    if (!fix || !rem.length) return;
    setRerouting(true);
    lastRerouteAtRef.current = Date.now();
    routeFrom({ lat: fix.lat, lng: fix.lng }, rem, pace)
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

  // ---- stop latching: arrivals and passed-by skips ----
  useEffect(() => {
    if (!fix) return;
    const wps = day.waypoints;
    const base = Math.max(progIdxRef.current, projRef.current?.i ?? 0);
    // Physically standing on a stop the projection has already walked past
    // latches it even though it isn't the nav target — the target-only check
    // below left such a stop unlatched, and the moment the projection rewound
    // (leaving on the same road you arrived by) remainingNav resurrected it
    // and nav turned the rider around (field-caught leaving Cozy Cabin,
    // Aug 11). Capped before the final stop so the arrival state stays real.
    for (let i = progIdxRef.current + 1; i <= Math.min(base, wps.length - 2); i++) {
      if (haversineMiles(fix, wps[i]) < ARRIVE_MI) setProgIdx((p) => Math.max(p, i));
    }
    // heading back to a restored stop takes priority over index order
    let ti = returnToRef.current ? wps.findIndex((w) => w.id === returnToRef.current) : -1;
    if (ti < 0) {
      for (let i = base + 1; i < wps.length; i++) {
        if (!skippedRef.current.has(wps[i].id)) { ti = i; break; }
      }
    }
    if (ti < 0) return;
    const target = wps[ti];
    const isLast = ti === wps.length - 1;
    const d = haversineMiles(fix, target);
    // The projection can walk PAST a spur stop at closest approach (the
    // nearest-segment flip happens exactly abeam), retargeting this effect
    // before the move-away counter completes. That silent hand-off IS a
    // pass-by: announce it and leave the undo chip, same as the detector.
    if (passRef.current && passRef.current.id !== target.id) {
      const old = passRef.current;
      passRef.current = null;
      const oi = wps.findIndex((w) => w.id === old.id);
      if (oi >= 0 && oi <= base && oi < wps.length - 1
        && old.min <= PASS_NEAR_MI && old.min > ARRIVE_MI
        && !skippedRef.current.has(old.id)) {
        setSkipped(new Set(skippedRef.current).add(old.id));
        setUndoSkip({ id: old.id, name: wps[oi].name });
        speak(`Passing ${wps[oi].name}. Skipping it — tap undo to go back.`);
      }
    }
    if (passRef.current?.id !== target.id) passRef.current = { id: target.id, min: d, lastD: d, away: 0 };
    const ps = passRef.current;
    // touched the stop: latch it visited (the final stop keeps the existing
    // 0.15-mi arrival state instead of latching early)
    if (d < ARRIVE_MI) {
      if (!isLast) {
        setProgIdx((p) => Math.max(p, ti));
        setUndoSkip(null);
        if (returnToRef.current === target.id) setReturnToId(null);
        passRef.current = null;
      }
      return;
    }
    ps.away = d > ps.lastD + 0.01 ? ps.away + 1 : 0;
    ps.lastD = d;
    if (d < ps.min) ps.min = d;
    // came close, now pulling away for several fixes: the rider isn't going in
    if (!isLast && ps.min <= PASS_NEAR_MI && d >= ps.min + PASS_AWAY_MI && ps.away >= 3) {
      passRef.current = null;
      const nextSkipped = new Set(skippedRef.current).add(target.id);
      setSkipped(nextSkipped);
      if (returnToRef.current === target.id) setReturnToId(null);
      setUndoSkip({ id: target.id, name: target.name });
      speak(`Passing ${target.name}. Skipping it — tap undo to go back.`);
      goRouteRef.current(wps.filter((w, i) => i > base && !nextSkipped.has(w.id)));
    }
  }, [fix]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const at = (p) => cum[p.i] + p.f * (cum[p.i + 1] - cum[p.i]);
    const bike = projectOnChain(chain, fix);
    initLatchRef.current = true;
    if (!bike || bike.off > 2) return; // far off the plan — off-route handles it
    const bikeAt = at(bike);
    // contiguous prefix only: the first stop that reads "ahead" ends the walk,
    // which also keeps out-and-back double-passage geometry from over-latching
    let latch = 0;
    for (let i = 1; i < day.waypoints.length - 1; i++) {
      const p = projectOnChain(chain, day.waypoints[i]);
      if (p && at(p) < bikeAt - 0.3) latch = i;
      else break;
    }
    if (latch > 0) setProgIdx((prev) => Math.max(prev, latch));
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
    return { chain, cum, total: cum[cum.length - 1] || 1 };
  }, [reroute, routes, day]);
  const geoProj = useMemo(
    () => (fix && geomInfo.chain.length > 1 ? projectOnChain(geomInfo.chain, fix) : null),
    [fix, geomInfo]
  );
  const goodFix = fix && (fix.accuracy == null || fix.accuracy < 200);
  const offRoute = !!(geoProj && goodFix && geoProj.off > (hasRealRoute ? 0.12 : 2.5));

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

  // dim the part of the route already ridden (Google-style traveled line)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getLayer('ride-route-line')) return;
    const layer = reroute ? 'ride-live-line' : 'ride-route-line';
    let frac = 0;
    if (geoProj && !offRoute) {
      const { cum, total } = geomInfo;
      frac = (cum[geoProj.i] + geoProj.f * (cum[geoProj.i + 1] - cum[geoProj.i])) / total;
    }
    frac = Math.max(0, Math.min(0.999, frac));
    map.setPaintProperty(layer, 'line-gradient',
      frac <= 0.001 ? SOLID_AHEAD : ['step', ['line-progress'], NAV_DONE, frac, NAV_AHEAD]);
  }, [geoProj, reroute, offRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- puck + chase camera, map-matched ----
  // Within ~30 m of the line the puck snaps onto it and takes the road's
  // bearing instead of the GPS one — kills the wobble like the big nav apps.
  // Between 1 Hz fixes the puck GLIDES to the new position on animation
  // frames instead of hopping once a second — the hop is what made tracking
  // feel a beat behind the bike.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fix) return undefined;
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
      const mph = fix.speedMph;
      // Zoom breathes with speed and tightens into the next turn. Tuned to
      // Google's nav framing: close on the rider, backing off ~a level at
      // highway speed for look-ahead — the old tiers (12.9–14.8) framed a
      // county, not a road.
      let zoom = mph == null ? 15.2 : mph >= 50 ? 14.3 : mph >= 25 ? 15.2 : 16.2;
      if (nav && nav.toNext < 0.35) zoom = Math.max(zoom, 16.5);
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
    routeFrom({ lat: fix.lat, lng: fix.lng }, remaining, pace)
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
      if (onPlanRef.current >= 3 && skippedRef.current.size === 0 && !returnToRef.current) {
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
    if (!skipped.size && !returnToId) return;
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
    routeFrom({ lat: fix.lat, lng: fix.lng }, remaining, pace)
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
    if (i <= effIdx || !w || skipped.has(w.id)) return a;
    return a + (s.dwell ?? 0);
  }, 0), [tl, day, effIdx, skipped]);
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

  // voice guidance at 1 mi / ¼ mi / on the turn
  useEffect(() => {
    if (!nav || !nav.next || offRoute) return;
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
      // a skipped fuel stop is fuel you are NOT getting — don't count it
      if (day.waypoints[j].fuel && !skipped.has(day.waypoints[j].id)) return { name: day.waypoints[j].name, miles: mi };
      mi += tl.stops[j + 1]?.legMiles ?? 0;
    }
    return null;
  }, [proj?.i, proj?.remainToNext, day, tl, skipped]); // eslint-disable-line react-hooks/exhaustive-deps

  // The next gate still ahead of the bike, with its live margin. One gate,
  // big — a row of tiny chips at 70 mph is decoration, not information.
  const nextGate = useMemo(() => {
    if (!fix) return null;
    for (const g of day.gates ?? []) {
      const idx = day.waypoints.findIndex((w) => w.id === g.waypointId);
      if (idx < 0 || (proj && idx <= proj.i) || skipped.has(g.waypointId)) continue;
      const s = tl.stops[idx];
      if (!s) continue;
      const projected = delta != null ? s.arrive + delta : s.arrive;
      const margin = parseTime(g.by) - projected;
      return { label: g.label, by: g.by, margin, ok: margin >= 0 };
    }
    return null;
  }, [fix, day, tl, delta, proj?.i, skipped]); // eslint-disable-line react-hooks/exhaustive-deps

  // Day's end: within a couple hundred yards of the last stop on its final leg.
  const lastWp = day.waypoints[day.waypoints.length - 1];
  const arrived = !!(fix && lastWp && proj
    && proj.i >= day.waypoints.length - 2
    && haversineMiles(fix, lastWp) < 0.15);

  // The remaining stops as swipeable cards — the roadbook strip. Google gives
  // you turns; a roadbook gives you the day. Skipped stops stay visible
  // (dimmed, restorable) — hiding them would make Restore undiscoverable.
  const stopsAhead = useMemo(() => {
    const from = effIdx + 1;
    return day.waypoints.slice(from).map((w, k) => {
      const i = from + k;
      const s = tl.stops[i];
      return {
        id: w.id, name: w.name, fuel: !!w.fuel, kind: w.kind,
        dwell: s?.dwell ?? 0,
        arrive: s ? (delta != null ? s.arrive + delta : s.arrive) : null,
        lat: w.lat, lng: w.lng,
        skipped: skipped.has(w.id),
        isLast: i === day.waypoints.length - 1,
      };
    });
  }, [day, tl, effIdx, delta, skipped]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deliberate destination control from the sheet: skip a stop, restore one,
  // or aim the route straight at a chosen stop (skipping everything between).
  const reSkip = (nextSkipped, nextReturnTo) => {
    setSkipped(nextSkipped);
    const ahead = day.waypoints.filter((w, i) => i > effIdx && !nextSkipped.has(w.id));
    const back = nextReturnTo ? day.waypoints.find((w) => w.id === nextReturnTo) : null;
    goRoute(back && !ahead.some((w) => w.id === nextReturnTo) ? [back, ...ahead] : ahead);
  };
  const skipStop = (id) => {
    if (undoSkip?.id === id) setUndoSkip(null);
    const nextReturnTo = returnToId === id ? null : returnToId;
    if (nextReturnTo !== returnToId) setReturnToId(nextReturnTo);
    reSkip(new Set(skipped).add(id), nextReturnTo);
  };
  const restoreStop = (id) => {
    const n = new Set(skipped);
    n.delete(id);
    if (undoSkip?.id === id) setUndoSkip(null);
    const k = day.waypoints.findIndex((w) => w.id === id);
    // Already behind the projection? Rewind the latch and pin it as the
    // explicit destination — the index filter alone can never re-add it, so
    // "UNDO" would say "heading back" while nav sailed on to the next stop.
    const behind = k >= 0 && k <= effIdx;
    const nextReturnTo = behind ? id : returnToId;
    if (behind) {
      setProgIdx((p) => Math.min(p, Math.max(0, k - 1)));
      setReturnToId(id);
    }
    reSkip(n, nextReturnTo);
  };
  const goNextStop = (id) => {
    const k = day.waypoints.findIndex((w) => w.id === id);
    if (k < 0) return;
    const n = new Set(skipped);
    // Skip from the LATCHED floor, not effIdx: effIdx rides the geometric
    // projection, which rewinds on an out-and-back spur — a stop the
    // projection had merely walked past would dodge the skip set here, then
    // come back as the destination on the next rewind. Latching the floor to
    // the chosen stop makes "everything before this is behind me" durable.
    for (let i = progIdx + 1; i < k; i++) n.add(day.waypoints[i].id);
    n.delete(id);
    setProgIdx((p) => Math.max(p, k - 1));
    setUndoSkip(null);
    setReturnToId(null);
    setSheetOpen(false);
    setFollow(true);
    speak(`Navigating to ${day.waypoints[k].name}.`);
    reSkip(n, null);
  };
  const undoLastSkip = () => {
    if (!undoSkip) return;
    const { id, name } = undoSkip;
    speak(`Heading back to ${name}.`);
    restoreStop(id);
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
    const anchor = fix ? { lat: fix.lat, lng: fix.lng } : day.waypoints[Math.min(effIdx, day.waypoints.length - 1)];
    const tail = [anchor, ...day.waypoints.slice(effIdx + 1)];
    const at = effIdx + Math.max(1, bestInsertIndex(tail, r));
    const wp = {
      name: r.name, lat: r.lat, lng: r.lng,
      kind: fuel ? 'fuel' : 'via',
      ...(fuel ? { fuel: true } : {}),
      ...(r.source === 'google' && r.id ? { placeId: r.id } : {}),
    };
    dispatch({ type: 'apply_ops', ops: [{ op: 'add_waypoint', dayId: day.id, index: at, waypoint: wp }] });
    setQ('');
    setFound(null);
    setSheetOpen(false);
    setFollow(true);
    speak(`Added ${r.name}. Rerouting.`);
    if (fix) {
      const after = day.waypoints.slice(effIdx + 1);
      after.splice(Math.max(0, at - effIdx - 1), 0, wp);
      goRoute(after.filter((w) => !skipped.has(w.id)));
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

    const labels = [];
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
      labels.push(label);
      wpMarkersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([w.lng, w.lat]).addTo(map));
    });

    // A label is centred on its stop, so a stop near the edge of the screen
    // hangs half its name off it — the first and last stop of a day, every
    // time. Slide those back inside instead of letting them get cut.
    const clamp = () => {
      const box = map.getContainer().getBoundingClientRect();
      labels.forEach((el) => {
        const prev = Number(el.dataset.dx || 0);
        const r = el.getBoundingClientRect();
        const left = r.left - box.left - prev; // where it would sit untranslated
        const dx = left < 6 ? 6 - left
          : left + r.width > box.width - 6 ? box.width - 6 - (left + r.width)
            : 0;
        if (dx !== prev) {
          el.dataset.dx = String(dx);
          el.style.transform = dx ? `translateX(${dx}px)` : '';
        }
      });
    };
    // Clamp only when the map SETTLES. Re-translating labels on every move
    // frame made them drift away from their dots mid-zoom; during a gesture
    // the label stays anchored, and slides inside the viewport when it lands.
    const unclamp = () => {
      labels.forEach((el) => {
        if (el.dataset.dx) { el.dataset.dx = '0'; el.style.transform = ''; }
      });
    };
    clamp();
    map.on('movestart', unclamp);
    map.on('moveend', clamp);
    map.on('zoomend', clamp);
    return () => {
      map.off('movestart', unclamp);
      map.off('moveend', clamp);
      map.off('zoomend', clamp);
      wpMarkersRef.current.forEach((m) => m.remove());
      wpMarkersRef.current = [];
    };
  }, [day, stopMarks, tt]);

  return (
    // any first tap unlocks the speech engine (ref-guarded to run once)
    <div className="ride-mode nav" onPointerDown={unlockVoice}>
      <div ref={mapDivRef} className="ride-map" />

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
            {nextGate && (
              <span className={`m-chip gate${nextGate.ok ? '' : ' danger'}`}>
                <ClockIcon />
                {tt(nextGate.label)} · {nextGate.ok ? `${fmtDur(nextGate.margin)} ${t('margin')}` : `${fmtDur(-nextGate.margin)} ${t('LATE')}`}
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
                      plan delta pinned right, and the leg ETA + miles get
                      their own row — sharing a row with the chip, a long
                      delta (+6h 39m) squeezed the miles into "99…" (field
                      bug). The day-end ETA stays demoted to the small rb-day
                      line so the leg and day numbers can't be confused. */}
                  <div className="rb-main">
                    <b className="rb-big">{legRemMin != null ? fmtDur(legRemMin) : '—'}</b>
                    {deltaChip && <span className={`rb-chip ${deltaChip.cls}`}>{deltaChip.text}</span>}
                  </div>
                  <span className="rb-mid">
                    {legEta != null ? fmtTime(legEta) : '—'}
                    {legMiles != null ? ` · ${u.miNum(legMiles)} ${u.miUnit}` : ''}
                  </span>
                </>
              )}
              {/* one footer row: the stop the leg numbers describe, and the
                  whole-day figure at the right — minimal sheds the day part */}
              {(nextWp ?? plannedNext) && !sheetOpen && (
                <div className="rb-foot">
                  <Marquee className="rb-next" label={lean ? null : t('Next')} text={tt((nextWp ?? plannedNext).name)} />
                  {fix && !lean && remainingNav.length > 1 && (eta ?? projectedEnd) != null && (
                    <span className="rb-day">
                      {t('Day')} {fmtTime(eta ?? projectedEnd)}
                      {nav ? ` · ${u.miNum(nav.remMi)} ${u.miUnit}` : ''}
                    </span>
                  )}
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

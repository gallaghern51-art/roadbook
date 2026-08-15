// Road routing. Planning uses the public OSRM demo server (free, cached hard).
// Ride Mode navigation tries the Google Routes API first via the
// google-route Netlify function (live-traffic ETAs; needs GOOGLE_MAPS_API_KEY
// in the Netlify env) and falls back to OSRM whenever the function is absent,
// unconfigured, or failing — the app never depends on the paid path.

import { legKey, haversineMiles } from './tripEngine.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

// v3: cached legs are CALIBRATED but UNPACED — the per-trip group-pace
// multiplier (meta.pace) is applied by consumers, so changing it never
// invalidates the cache. v2 briefly carried routes computed with
// snapping=any + continue_straight=false, which let the router U-turn at a
// via instead of riding THROUGH it (it cut a mountain pass in half, touching
// the summit stop and doubling back); those flush with the bump.
const CACHE_KEY = 'sturgis.routeCache.v3';

// ---- speed calibration ----
// The public OSRM demo times US highways like a cautious rental car: rural
// roads with no maxspeed tag fall back to the car profile's class defaults
// (motorway 90 km/h ≈ 56 mph, primary 65 km/h ≈ 40 mph) and tagged limits are
// discounted ~10% — all well under how these roads actually ride. Map each
// routed segment's profile speed onto a realistic cruise: town and junction
// speeds stay honest, highway speeds get restored to posted-ish reality.
// Anchors are [profile mph, realistic mph], piecewise-linear between them.
const SPEED_CURVE = [
  [0, 0], [25, 25],          // urban / ramps / switchbacks — believe the router
  [34, 42],                  // untagged secondary default (55 km/h)
  [40, 52],                  // untagged primary default (65 km/h) — rural two-lane
  [53, 65],                  // untagged trunk default (85 km/h)
  [56, 70],                  // untagged motorway default (90 km/h)
  [63, 72],                  // tagged 70 mph × 0.9
  [67.5, 77],                // tagged 75 mph × 0.9
  [72, 80],                  // tagged 80 mph × 0.9
  [82, 82],                  // never plan faster than this
];
export function calibrateMph(mph) {
  if (!Number.isFinite(mph) || mph <= 0) return mph;
  const last = SPEED_CURVE[SPEED_CURVE.length - 1];
  if (mph >= last[0]) return last[1];
  for (let i = 1; i < SPEED_CURVE.length; i++) {
    const [x1, y1] = SPEED_CURVE[i - 1];
    const [x2, y2] = SPEED_CURVE[i];
    if (mph <= x2) return y1 + ((mph - x1) / (x2 - x1)) * (y2 - y1);
  }
  return mph;
}

// Re-time one OSRM leg from its per-segment annotation (distance/duration
// arrays). Returns calibrated seconds, or null when the annotation is absent.
function calibratedLegSeconds(leg) {
  const ann = leg?.annotation;
  const dist = ann?.distance;
  const dur = ann?.duration;
  if (!Array.isArray(dist) || !Array.isArray(dur) || dist.length !== dur.length || !dist.length) return null;
  let sec = 0;
  for (let i = 0; i < dist.length; i++) {
    if (!(dur[i] > 0) || !(dist[i] > 0)) { sec += dur[i] > 0 ? dur[i] : 0; continue; }
    const mph = (dist[i] / dur[i]) * 2.23694;
    const out = calibrateMph(mph);
    sec += out > 0 ? dist[i] / (out / 2.23694) : dur[i];
  }
  return sec;
}

// Apply the trip's pace multiplier to a step list at read time.
const paceSteps = (steps, pace) => (pace === 1 || !steps
  ? steps
  : steps.map((s) => ({ ...s, sec: (s.sec ?? 0) * pace })));

// ---- Google Routes proxy (traffic-aware) ----

const GOOGLE_FN = '/.netlify/functions/google-route';
let gSkipUntil = 0; // backoff so a dead/keyless function costs one probe, not one per reroute

async function googleRoute(origin, waypoints) {
  if (Date.now() < gSkipUntil) throw new Error('google routing backing off');
  let res;
  try {
    res = await fetch(GOOGLE_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // heading rides along when the caller has one — the route then
        // departs the way the bike is pointed instead of assuming a
        // direction from the road snap
        origin: {
          lat: origin.lat, lng: origin.lng,
          ...(Number.isFinite(origin.heading) ? { heading: ((Math.round(origin.heading) % 360) + 360) % 360 } : {}),
        },
        // place identity rides along when a stop has it — the route function
        // snaps those to the place instead of the raw coordinate
        waypoints: waypoints.map((w) => ({ lat: w.lat, lng: w.lng, ...(w.placeId ? { placeId: w.placeId } : {}) })),
      }),
    });
  } catch (e) {
    gSkipUntil = Date.now() + 5 * 60_000;
    throw e;
  }
  if (!res.ok) {
    // 501 = no key configured, 404 = running under plain vite dev — stay off it longer
    gSkipUntil = Date.now() + (res.status === 501 || res.status === 404 ? 30 : 5) * 60_000;
    throw new Error(`google-route ${res.status}`);
  }
  const json = await res.json();
  if (!json.geometry?.length) throw new Error('google-route empty');
  return json;
}

// Google maneuver enum → our OSRM-flavored {type, mod} (drives TurnArrow + voice).
const G_MANEUVER = {
  DEPART: ['depart', null], NAME_CHANGE: ['new name', null], STRAIGHT: ['continue', 'straight'],
  TURN_LEFT: ['turn', 'left'], TURN_RIGHT: ['turn', 'right'],
  TURN_SLIGHT_LEFT: ['turn', 'slight left'], TURN_SLIGHT_RIGHT: ['turn', 'slight right'],
  TURN_SHARP_LEFT: ['turn', 'sharp left'], TURN_SHARP_RIGHT: ['turn', 'sharp right'],
  UTURN_LEFT: ['turn', 'uturn'], UTURN_RIGHT: ['turn', 'uturn'],
  RAMP_LEFT: ['on ramp', 'left'], RAMP_RIGHT: ['on ramp', 'right'],
  MERGE: ['merge', null], FORK_LEFT: ['fork', 'left'], FORK_RIGHT: ['fork', 'right'],
  ROUNDABOUT_LEFT: ['roundabout', null], ROUNDABOUT_RIGHT: ['roundabout', null],
};

// Google gives static per-step durations but a traffic-aware total — spread the
// traffic over the steps proportionally so ETA math stays per-step.
// Steps come out UNPACED; callers apply the trip's pace multiplier.
function googleCompactSteps(g, stops) {
  const totalStatic = g.legs.reduce((a, l) => a + l.steps.reduce((b, s) => b + s.staticDurationSeconds, 0), 0);
  const scale = totalStatic > 0 ? g.durationSeconds / totalStatic : 1;
  const steps = [];
  g.legs.forEach((leg, li) => {
    for (const st of leg.steps) {
      if (!Number.isFinite(st.lat) || !Number.isFinite(st.lng)) continue;
      const [type, mod] = G_MANEUVER[st.maneuver] ?? ['turn', null];
      steps.push({
        lat: st.lat, lng: st.lng,
        dist: st.distanceMeters / 1609.34,
        sec: st.staticDurationSeconds * scale,
        type, mod, exit: null, road: null,
        instr: st.instruction || 'Continue',
      });
    }
    // Google has no arrive maneuver per leg — synthesize one at the stop itself
    const wp = stops?.[li];
    if (wp) {
      steps.push({
        lat: wp.lat, lng: wp.lng, dist: 0, sec: 0,
        type: 'arrive', mod: null, exit: null, road: null,
        stop: wp.name ?? null, // which stop this leg ends at — drives per-leg ETA
        instr: wp.name ? `Arrive: ${wp.name}` : 'Arrive at your stop',
      });
    }
  });
  return steps;
}

let cache = null;
function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    cache = {};
  }
  return cache;
}
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // cache full — drop it and carry on
    localStorage.removeItem(CACHE_KEY);
  }
}

// Route one day's waypoints in one OSRM call (it handles many vias fine).
// Returns { legs: {legKey: {miles, seconds}}, geometry, snaps: {wpId: meters} }.
// Leg seconds are calibrated (see SPEED_CURVE) but unpaced. `snaps` records how
// far each pin sat from the road network — a big number is a mis-placed pin
// that forces the route into an out-and-back spur to touch it; the day panel
// warns on those so the pin gets fixed at the source.
// Deliberately NO continue_straight=false / snapping=any here: allowing
// U-turns at vias let the router touch a mid-pass stop and double back
// instead of riding through the pass — on a motorcycle route the road is
// the point, so vias keep OSRM's ride-through default.
export async function routeDay(day) {
  const wps = day.waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (wps.length < 2) return { legs: {}, geometry: null };

  const c = loadCache();
  const dayKey = wps.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';');
  if (c[dayKey]) return c[dayKey];

  const coords = wps.map((w) => `${w.lng},${w.lat}`).join(';');
  const url = `${OSRM}/${coords}?overview=full&geometries=geojson&steps=false&annotations=distance,duration`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const json = await res.json();
    const route = json.routes?.[0];
    if (!route) throw new Error('no route');
    const legs = {};
    route.legs.forEach((leg, i) => {
      legs[legKey(wps[i], wps[i + 1])] = {
        miles: leg.distance / 1609.34,
        seconds: calibratedLegSeconds(leg) ?? leg.duration,
      };
    });
    const snaps = {};
    wps.forEach((w, i) => {
      const m = json.waypoints?.[i]?.distance;
      if (Number.isFinite(m)) snaps[w.id] = Math.round(m);
    });
    // 5 decimals ≈ 1 m — plenty for drawing, off-route checks (0.12 mi), and
    // puck snapping (30 m), and it nearly halves the cached JSON. An 11-day
    // trip's geometry has to fit localStorage next to everything else.
    const geometry = route.geometry.coordinates.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
    const result = { legs, geometry, snaps };
    c[dayKey] = result;
    saveCache();
    return result;
  } catch {
    // Fallback: straight lines between waypoints, doc mileage drives the metrics.
    return { legs: {}, geometry: wps.map((w) => [w.lng, w.lat]), fallback: true };
  }
}

// Turn-by-turn maneuvers for Ride Mode. Fetched per day on demand (steps inflate
// payloads ~10x, so they never ride along with the planning fetch) and cached
// as compact maneuver points only.
// v4: step durations are calibrated (SPEED_CURVE) and UNPACED — pace applies at
// read time — and arrive steps carry their stop name for per-leg ETAs. v3
// briefly held routes allowed to U-turn at vias (see CACHE_KEY note).
const STEP_CACHE = 'moto.stepsCache.v4';

// Old cache generations are multi-MB dead weight. Left in place they push
// localStorage over the phone's quota, every save of the CURRENT cache then
// fails, the failure handler drops it — and the app re-routes the whole trip
// on every launch. Purge anything that isn't the current generation.
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if ((k?.startsWith('sturgis.routeCache.') && k !== CACHE_KEY)
      || (k?.startsWith('moto.stepsCache.') && k !== STEP_CACHE)
      || (k?.startsWith('moto.roadCache.') && k !== 'moto.roadCache.v1')) {
      localStorage.removeItem(k);
    }
  }
} catch { /* storage unavailable — nothing to purge */ }

function loadStepCache() {
  try { return JSON.parse(localStorage.getItem(STEP_CACHE) || '{}'); } catch { return {}; }
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function instructionFor(step, arriveName) {
  const m = step.maneuver;
  const mod = m.modifier ?? '';
  const road = step.name || step.ref || '';
  const onto = road ? ` onto ${road}` : '';
  // Highway signage ("toward Billings / Sheridan") reads better at speed than road names.
  const toward = step.destinations ? ` toward ${step.destinations.split(',').slice(0, 2).join(' / ')}` : '';
  switch (m.type) {
    case 'depart': return road ? `Head out on ${road}` : 'Head out';
    case 'arrive': return arriveName ? `Arrive: ${arriveName}` : 'Arrive at your stop';
    case 'merge': return `Merge ${mod}${onto}${toward}`;
    case 'on ramp': return `Take the ramp${onto}${toward}`;
    case 'off ramp': return `Take the exit${toward || onto}`;
    case 'fork': return `Keep ${mod}${toward || onto}`;
    case 'end of road': return `${cap(mod) || 'Turn'} at the end of the road${onto}`;
    case 'roundabout':
    case 'rotary': return `Roundabout — take exit ${m.exit ?? ''}${onto}`.replace('exit  ', 'the exit ');
    case 'continue': return mod && mod !== 'straight' ? `${cap(mod)}${onto}` : `Continue${road ? ` on ${road}` : ''}`;
    case 'new name': return `Continue${road ? ` on ${road}` : ''}`;
    default: return mod ? `${cap(mod) === 'Straight' ? 'Continue' : `Turn ${mod}`}${onto}` : `Continue${onto}`;
  }
}


// ---------- lane guidance ----------
// The row of arrows painted on the road before a junction. OSRM carries it on
// `intersections[0].lanes` of the step whose maneuver you are approaching —
// `valid` marks the lanes that actually carry you through that maneuver. It
// comes from OSM `turn:lanes` tags, so interstates and big junctions are well
// covered and rural two-lanes usually have nothing, which is fine: no lanes
// means the HUD just shows the maneuver arrow as before.
//
// Stored compactly ({v, i}) because the whole step list lives in localStorage.
const LANE_CAP = 6; // a phone cannot legibly show more than this

function laneCells(step) {
  const lanes = step.intersections?.[0]?.lanes;
  if (!Array.isArray(lanes) || !lanes.length) return null;
  return lanes.slice(0, LANE_CAP).map((l) => ({
    v: l.valid ? 1 : 0,
    i: Array.isArray(l.indications) ? l.indications : [],
  }));
}

// Google returns no lane guidance on any web API — it is Navigation-SDK-only —
// and no route REF either: the road number is only ever prose inside the
// instruction ("Merge onto I-90 E"). Both are static facts about the road, so
// both can be fetched from OSRM once and matched onto Google's maneuver chain
// by position. Best effort: if this fails the HUD is exactly what it was.
const LANE_MATCH_MI = 0.03; // ~50 m: same junction, different router's idea of where

export async function attachRoadDetail(steps, wps) {
  if (!steps?.length || steps.some((s) => s.lanes || s.road)) return steps;
  try {
    const coords = wps.map((w) => `${w.lng},${w.lat}`).join(';');
    const res = await fetch(`${OSRM}/${coords}?overview=false&steps=true&annotations=false`);
    if (!res.ok) return steps;
    const route = (await res.json()).routes?.[0];
    if (!route) return steps;

    const points = [];
    for (const leg of route.legs) {
      for (const st of leg.steps) {
        const cells = laneCells(st);
        const ref = st.ref || null;
        if (cells || ref) points.push({ lat: st.maneuver.location[1], lng: st.maneuver.location[0], cells, ref });
      }
    }
    if (!points.length) return steps;

    return steps.map((s) => {
      let best = null;
      for (const p of points) {
        const d = haversineMiles(s, p);
        if (d <= LANE_MATCH_MI && (!best || d < best.d)) best = { d, ...p };
      }
      if (!best) return s;
      return { ...s, lanes: best.cells ?? s.lanes, road: s.road ?? best.ref };
    });
  } catch {
    return steps;
  }
}

// OSRM route → compact maneuver list. `stopNames[i]` names the arrive point of leg i.
// Step durations are scaled by the leg's calibration factor (annotation-derived,
// see SPEED_CURVE) and left unpaced — callers apply the trip's pace.
function compactSteps(route, stopNames) {
  const steps = [];
  route.legs.forEach((leg, li) => {
    const cal = calibratedLegSeconds(leg);
    const factor = cal != null && leg.duration > 0 ? cal / leg.duration : 1;
    leg.steps.forEach((st) => {
      const isArrive = st.maneuver.type === 'arrive';
      steps.push({
        lat: st.maneuver.location[1],
        lng: st.maneuver.location[0],
        dist: st.distance / 1609.34, // miles from this maneuver to the next
        sec: st.duration * factor,
        type: st.maneuver.type,
        stop: isArrive ? stopNames?.[li] ?? null : undefined,
        mod: st.maneuver.modifier ?? null,
        exit: st.maneuver.exit ?? null,
        road: st.ref || st.name || null,
        // The street name on its own. The banner shows this beside the shield —
        // "Huffine Lane", not "Turn left onto Huffine Lane" — because the arrow
        // has already said "turn left" and the sentence only costs it a line.
        roadName: st.name || null,
        exitNo: st.exits || null, // signed exit number, when the junction carries one
        lanes: laneCells(st),
        instr: instructionFor(st, isArrive ? stopNames?.[li] : null),
      });
    });
  });
  return steps;
}

function saveStepCache(key, value) {
  try {
    const next = loadStepCache();
    next[key] = value;
    localStorage.setItem(STEP_CACHE, JSON.stringify(next));
  } catch { localStorage.removeItem(STEP_CACHE); }
}

export async function routeDaySteps(day, pace = 1) {
  const wps = day.waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (wps.length < 2) return [];
  const key = 'steps|' + wps.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';');
  const c = loadStepCache();
  const hit = c[key];
  if (Array.isArray(hit)) return paceSteps(hit, pace); // OSRM-sourced: static data, cache forever
  if (hit?.g && Date.now() - hit.at < 15 * 60_000) return paceSteps(hit.steps, pace); // traffic goes stale

  // Traffic-aware first; OSRM below is the always-works fallback.
  try {
    const g = await googleRoute(wps[0], wps.slice(1));
    const steps = await attachRoadDetail(googleCompactSteps(g, wps.slice(1)), wps);
    saveStepCache(key, { g: 1, at: Date.now(), steps });
    return paceSteps(steps, pace);
  } catch { /* fall through to OSRM */ }

  const coords = wps.map((w) => `${w.lng},${w.lat}`).join(';');
  const url = `${OSRM}/${coords}?overview=false&steps=true&annotations=distance,duration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`routing ${res.status}`);
  const json = await res.json();
  const route = json.routes?.[0];
  if (!route) throw new Error('no route');

  const steps = compactSteps(route, wps.slice(1).map((w) => w.name));
  saveStepCache(key, steps);
  return paceSteps(steps, pace);
}

// ---- road numbers for the PLAN map ----
// Shields on the planning map need one thing the planning route does not
// carry: which route number each stretch runs on. Deliberately NOT served by
// routeDaySteps — that one tries Google first (billable, per selected day,
// and Google has no ref field anyway), while OSRM answers with real OSM refs
// for free. Only the ref and the length it holds are kept, so the whole cache
// for an 11-day trip is a few KB.
const ROAD_CACHE = 'moto.roadCache.v1';

export async function routeDayRoads(day) {
  const wps = (day.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (wps.length < 2) return [];
  const key = wps.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';');
  let store = {};
  try { store = JSON.parse(localStorage.getItem(ROAD_CACHE) || '{}'); } catch { store = {}; }
  if (store[key]) return store[key];

  const coords = wps.map((w) => `${w.lng},${w.lat}`).join(';');
  const res = await fetch(`${OSRM}/${coords}?overview=false&steps=true&annotations=false`);
  if (!res.ok) throw new Error(`roads ${res.status}`);
  const route = (await res.json()).routes?.[0];
  if (!route) throw new Error('no route');
  const out = [];
  for (const leg of route.legs) {
    for (const st of leg.steps) {
      out.push({ dist: st.distance / 1609.34, road: st.ref || null });
    }
  }
  store[key] = out;
  try { localStorage.setItem(ROAD_CACHE, JSON.stringify(store)); } catch { localStorage.removeItem(ROAD_CACHE); }
  return out;
}

// Live reroute: current GPS position → the day's remaining waypoints.
// Never cached (the origin is wherever the bike is right now).
// Traffic-aware via Google when configured, OSRM otherwise.
// Returns { geometry, steps, miles, seconds, traffic? } or throws.
export async function routeFrom(pos, waypoints, pace = 1) {
  const wps = waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (!wps.length) throw new Error('no destination');

  try {
    const g = await googleRoute(pos, wps);
    return {
      geometry: g.geometry,
      steps: paceSteps(googleCompactSteps(g, wps), pace),
      miles: g.distanceMeters / 1609.34,
      seconds: g.durationSeconds * pace,
      traffic: true,
    };
  } catch { /* fall through to OSRM */ }

  const pts = [pos, ...wps];
  const coords = pts.map((p) => `${p.lng},${p.lat}`).join(';');
  // The bike's heading constrains the DEPARTURE only (±45°) — every other
  // point stays unrestricted. Without it OSRM picks a departure direction
  // from the snap alone and can route the wrong way up the road.
  const bearings = Number.isFinite(pos.heading)
    ? `&bearings=${((Math.round(pos.heading) % 360) + 360) % 360},45${';'.repeat(pts.length - 1)}`
    : '';
  const url = `${OSRM}/${coords}?overview=full&geometries=geojson&steps=true&annotations=distance,duration${bearings}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`reroute ${res.status}`);
  const json = await res.json();
  const route = json.routes?.[0];
  if (!route) throw new Error('no route');
  const steps = compactSteps(route, wps.map((w) => w.name));
  const calSec = route.legs.reduce((a, l) => a + (calibratedLegSeconds(l) ?? l.duration), 0);
  return {
    geometry: route.geometry.coordinates,
    steps: paceSteps(steps, pace),
    miles: route.distance / 1609.34,
    seconds: calSec * pace,
  };
}

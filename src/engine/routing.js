// Road routing. Valhalla motorcycle costing owns both planning and Ride Mode,
// so opening navigation cannot replace the road the rider chose. If Valhalla
// is unavailable, planning falls directly to OSRM; Ride Mode tries Google
// Routes (via the Netlify function, when configured) and then OSRM. Each tier
// backs off on failure, so the app never depends on a single router.

import {
  legKey, haversineMiles, projectOnChain, normalizeRoutePrefs, routePrefsKey,
} from './tripEngine.js';

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

// v5: route-character preferences became part of every Valhalla request and
// cache key. Flush v4 so a legacy neutral route cannot mask a rider's choice.
// Cached legs remain UNPACED — the per-trip group-pace multiplier (meta.pace)
// is applied by consumers, so changing pace never invalidates the cache.
const CACHE_KEY = 'sturgis.routeCache.v5';

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

// ---------- Valhalla (FOSSGIS public server) ----------
// The open-source engine tier between Google and OSRM: real MOTORCYCLE
// costing, heading-aware departures, and rich maneuver text. Community
// server, fair-use policy like the OSRM demo — every failure backs off and
// falls through, so it can only ever add quality, never remove a fallback.
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
let vSkipUntil = 0;

// Valhalla shapes are encoded polylines with SIX decimal digits (not five).
function decodePolyline6(str) {
  const out = [];
  let lat = 0, lng = 0, i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, byte;
      do { byte = str.charCodeAt(i++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

// Valhalla maneuver-type enum → our OSRM-flavored {type, mod}.
const V_MANEUVER = {
  1: ['depart', null], 2: ['depart', null], 3: ['depart', null],
  4: ['arrive', null], 5: ['arrive', null], 6: ['arrive', null],
  7: ['new name', null], 8: ['continue', 'straight'],
  9: ['turn', 'slight right'], 10: ['turn', 'right'], 11: ['turn', 'sharp right'],
  12: ['turn', 'uturn'], 13: ['turn', 'uturn'],
  14: ['turn', 'sharp left'], 15: ['turn', 'left'], 16: ['turn', 'slight left'],
  17: ['on ramp', null], 18: ['on ramp', 'right'], 19: ['on ramp', 'left'],
  20: ['off ramp', 'right'], 21: ['off ramp', 'left'],
  22: ['fork', 'straight'], 23: ['fork', 'right'], 24: ['fork', 'left'],
  25: ['merge', null], 37: ['merge', 'right'], 38: ['merge', 'left'],
  26: ['roundabout', null], 27: ['exit roundabout', null],
};

// Valhalla exposes motorcycle preference weights rather than named profiles.
// Keep their translation in one place so planning, maneuvers, and reroutes can
// never disagree. `use_trails: 0` is intentional: an unpaved/trail control
// needs its own safety language and should never arrive as a side effect of
// asking for back roads.
function valhallaMotorcycleOptions(value) {
  const prefs = normalizeRoutePrefs(value);
  const useHighways = { quick: 1, touring: 0.5, backroads: 0.05 }[prefs.style];
  return {
    use_highways: useHighways,
    use_tolls: prefs.avoidTolls ? 0 : 0.5,
    use_trails: 0,
  };
}

async function valhallaRoute(origin, wps, routePrefs) {
  if (Date.now() < vSkipUntil) throw new Error('valhalla backing off');
  const body = {
    locations: [
      {
        lon: origin.lng, lat: origin.lat, type: 'break',
        // like Google: the route departs the way the bike is pointed
        ...(Number.isFinite(origin.heading)
          ? { heading: ((Math.round(origin.heading) % 360) + 360) % 360, heading_tolerance: 60 }
          : {}),
      },
      ...wps.map((w, i) => ({
        lon: w.lng,
        lat: w.lat,
        // Intermediate points still split the response into per-stop legs,
        // but the route must continue through them instead of U-turning. The
        // final location is always a true break.
        type: i === wps.length - 1 ? 'break' : 'break_through',
      })),
    ],
    costing: 'motorcycle',
    costing_options: { motorcycle: valhallaMotorcycleOptions(routePrefs) },
    directions_options: { units: 'miles' },
  };
  let res;
  try {
    res = await fetch(VALHALLA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    vSkipUntil = Date.now() + 10 * 60_000;
    throw e;
  }
  if (!res.ok) {
    vSkipUntil = Date.now() + (res.status === 429 ? 30 : 10) * 60_000;
    throw new Error(`valhalla ${res.status}`);
  }
  const json = await res.json();
  if (!json.trip?.legs?.length) throw new Error('valhalla empty');
  return json.trip;
}

const valhallaGeometry = (trip) => {
  const geometry = [];
  for (const leg of trip.legs) {
    const shape = decodePolyline6(leg.shape ?? '');
    geometry.push(...(geometry.length ? shape.slice(1) : shape));
  }
  return geometry;
};

// Valhalla legs → our compact step shape. Lengths arrive in miles (units:
// miles), times in seconds — realistic for the motorcycle costing, so no
// SPEED_CURVE re-timing; pace applies at read time like every source.
function valhallaCompactSteps(trip, stops) {
  const steps = [];
  trip.legs.forEach((leg, li) => {
    const shape = decodePolyline6(leg.shape ?? '');
    for (const m of leg.maneuvers ?? []) {
      const pt = shape[Math.min(m.begin_shape_index ?? 0, shape.length - 1)];
      if (!pt) continue;
      const [type, mod] = V_MANEUVER[m.type] ?? ['turn', null];
      const isArrive = type === 'arrive';
      const wp = stops?.[li];
      steps.push({
        lat: pt[1], lng: pt[0],
        dist: m.length ?? 0,
        sec: m.time ?? 0,
        type, mod,
        exit: m.roundabout_exit_count ?? null,
        // .road is the SHIELD field and wants a route number (US-16A), which
        // Valhalla maneuvers do not carry — attachRoadDetail grafts real OSM
        // refs on afterwards. Putting a street name here both tripped that
        // graft's "already populated" guard (killing lane guidance) and asked
        // the HUD to draw a shield for "Granite Pass Road".
        road: null,
        roadName: m.street_names?.[0] ?? null,
        stop: isArrive ? wp?.name ?? null : undefined,
        instr: isArrive
          ? (wp?.name ? `Arrive: ${wp.name}` : 'Arrive at your stop')
          : ((m.instruction || 'Continue').replace(/\.$/, '')),
      });
    }
  });
  return steps;
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

// Route one day's waypoints in one Valhalla call, using real motorcycle
// costing. OSRM remains the safety fallback if the community endpoint is down.
// Returns { legs: {legKey: {miles, seconds}}, geometry, snaps: {wpId: meters} }.
// Leg seconds are realistic Valhalla estimates (or calibrated OSRM fallback
// estimates) but unpaced. `snaps` records how far each pin sat from the routed
// road — a big number is a mis-placed pin that forces an out-and-back spur;
// the day panel warns on those so the pin gets fixed at the source.
export async function routeDay(day, routePrefs) {
  const wps = day.waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (wps.length < 2) return { legs: {}, geometry: null };

  const c = loadCache();
  const dayKey = `${routePrefsKey(routePrefs)}|${wps.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';')}`;
  const hit = c[dayKey];
  // A Valhalla result is static until the points move. An OSRM fallback only
  // lives for Valhalla's backoff window; otherwise one transient outage would
  // quietly pin this day to the fallback forever.
  if (hit && (hit.source !== 'osrm' || Date.now() < (hit.retryAt ?? 0))) return hit;

  // Valhalla returns road-snapped geometry but not the OSRM-style snap offset.
  // Project each original pin onto the returned shape to preserve the existing
  // >150 m warning. This is the same projection primitive Ride Mode uses.
  const snapsFor = (geometry) => {
    const chain = geometry.map(([lng, lat]) => ({ lng, lat }));
    if (chain.length < 2) return {};
    const snaps = {};
    for (const w of wps) {
      const p = projectOnChain(chain, w);
      if (Number.isFinite(p?.off)) snaps[w.id] = Math.round(p.off * 1609.34);
    }
    return snaps;
  };

  try {
    const trip = await valhallaRoute(wps[0], wps.slice(1), routePrefs);
    if (trip.legs.length !== wps.length - 1) throw new Error('valhalla leg mismatch');
    const legs = {};
    trip.legs.forEach((leg, i) => {
      const miles = Number.isFinite(leg.summary?.length)
        ? leg.summary.length
        : (leg.maneuvers ?? []).reduce((sum, m) => sum + (Number.isFinite(m.length) ? m.length : 0), 0);
      const seconds = Number.isFinite(leg.summary?.time)
        ? leg.summary.time
        : (leg.maneuvers ?? []).reduce((sum, m) => sum + (Number.isFinite(m.time) ? m.time : 0), 0);
      legs[legKey(wps[i], wps[i + 1])] = {
        miles,
        seconds,
      };
    });
    // 5 decimals ≈ 1 m — plenty for drawing, off-route checks (0.12 mi), and
    // puck snapping (30 m), and it nearly halves the cached JSON. An 11-day
    // trip's geometry has to fit localStorage next to everything else.
    const geometry = valhallaGeometry(trip).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
    if (geometry.length < 2) throw new Error('valhalla geometry empty');
    const result = { legs, geometry, snaps: snapsFor(geometry), source: 'valhalla' };
    c[dayKey] = result;
    saveCache();
    return result;
  } catch { /* fall through to OSRM */ }

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
    const geometry = route.geometry.coordinates.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
    const result = { legs, geometry, snaps, source: 'osrm', retryAt: vSkipUntil };
    c[dayKey] = result;
    saveCache();
    return result;
  } catch {
    // Last-resort straight lines keep the itinerary usable without any router.
    return { legs: {}, geometry: wps.map((w) => [w.lng, w.lat]), fallback: true };
  }
}

// Turn-by-turn maneuvers for Ride Mode. Fetched per day on demand (steps inflate
// payloads ~10x, so they never ride along with the planning fetch) and cached
// as compact maneuver points only.
// v6: route character now keys navigation maneuvers as well as plan geometry.
// Flush v5 so a legacy neutral route cannot mask the current trip preference.
// Durations remain UNPACED — pace applies at read time — and arrive steps carry
// their stop name for per-leg ETAs.
const STEP_CACHE = 'moto.stepsCache.v6';

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

export async function routeDaySteps(day, pace = 1, routePrefs) {
  const wps = day.waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (wps.length < 2) return [];
  const key = `steps|${routePrefsKey(routePrefs)}|${wps.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';')}`;
  const c = loadStepCache();
  const hit = c[key];
  if (Array.isArray(hit)) return paceSteps(hit, pace); // open-source routers: static data, cache forever
  if (hit?.g) {
    // Google is an outage fallback now, not the route owner. Keep it only until
    // either its traffic is stale or Valhalla's backoff ends, whichever is first.
    const trafficUntil = hit.at + 15 * 60_000;
    const freshUntil = Math.min(trafficUntil, Number.isFinite(hit.retryAt) ? hit.retryAt : trafficUntil);
    if (Date.now() < freshUntil) return paceSteps(hit.steps, pace);
  }

  // Motorcycle routing first: navigation follows the same engine as planning.
  try {
    const trip = await valhallaRoute(wps[0], wps.slice(1), routePrefs);
    const steps = await attachRoadDetail(valhallaCompactSteps(trip, wps.slice(1)), wps);
    saveStepCache(key, steps); // no traffic inside — static data caches forever
    return paceSteps(steps, pace);
  } catch { /* fall through to Google */ }

  // A Valhalla outage should not strand a rider. Google remains the stronger
  // hosted fallback when configured; OSRM below is the final open fallback.
  try {
    const g = await googleRoute(wps[0], wps.slice(1));
    const steps = await attachRoadDetail(googleCompactSteps(g, wps.slice(1)), wps);
    saveStepCache(key, { g: 1, at: Date.now(), retryAt: vSkipUntil, steps });
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
// routeDaySteps — routing there may still call Google during a Valhalla outage,
// and Google has no ref field anyway, while OSRM answers with real OSM refs for
// free. Only the ref and the length it holds are kept, so the whole cache
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
// Valhalla first, then Google when configured, then OSRM.
// Returns { geometry, steps, miles, seconds, traffic? } or throws.
export async function routeFrom(pos, waypoints, pace = 1, routePrefs) {
  const wps = waypoints.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
  if (!wps.length) throw new Error('no destination');

  try {
    const trip = await valhallaRoute(pos, wps, routePrefs);
    return {
      geometry: valhallaGeometry(trip),
      steps: paceSteps(valhallaCompactSteps(trip, wps), pace),
      miles: trip.summary?.length ?? 0,
      seconds: (trip.summary?.time ?? 0) * pace,
    };
  } catch { /* fall through to Google */ }

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

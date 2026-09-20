// Route options: every road worth offering between two points, measured.
//
// Google and Apple show you two or three grey lines and let you pick. Roadbook
// has something they do not — a road CHARACTER choice (Quick / Touring / Back
// roads, Valhalla motorcycle costing) — but until now that choice was a
// setting applied behind the rider's back: you picked "Back roads" and the
// line changed, with no way to see what you were choosing between.
//
// This asks every style for its road AND asks Valhalla for its alternates, then
// merges them into one honest list.
//
// Three measured facts shape the design (public Valhalla, Sep 20, 2026):
//
//  1. Alternates arrive ONLY for a two-location request. One `break_through`
//     in the middle and the server returns none. So a quick ride (start → one
//     destination) gets the full Google-style set; a day with stops in it gets
//     the style roads alone. The UI must not promise more than that.
//
//  2. Alternates arrive only where the map offers another way. Minneapolis →
//     Rapid City gives two; Red Lodge → Cooke City gives none, because there
//     is exactly one road over the Beartooth. "One way to go" is a real
//     answer, rendered as one option, not as a failure.
//
//  3. The styles largely RE-RANK one candidate set rather than generating
//     different roads — and Valhalla's `use_highways: 1` primary is not
//     necessarily the fastest road it knows. Measured MN → Rapid City: the
//     "quick" primary came back 610.4 mi / 8h50 while a 576.7 mi / 8h37 road
//     sat in its own alternates list. A chip that says Quick must therefore be
//     answered with the FASTEST road of that style's set, not with whatever
//     the costing ranked first, or the label lies.

import { valhallaTrips } from './routing.js';
import { normalizeRoadRef, roadShields } from './roads.js';
import { normalizeRoutePrefs } from './tripEngine.js';

export const ROUTE_STYLES = [
  { id: 'quick', label: 'Quick', hint: 'Highways, least time' },
  { id: 'touring', label: 'Touring', hint: 'A balance of pace and road' },
  { id: 'backroads', label: 'Back roads', hint: 'Small roads, the long way' },
];

export const styleLabel = (id) => ROUTE_STYLES.find((s) => s.id === id)?.label ?? id;

// ---- what road is this? ----

/**
 * The road numbers a trip actually rides, by how far it rides them. Valhalla
 * has no route-ref field, but its maneuver `street_names` carry the number on
 * numbered roads ("I 90", "SD 44 East"), which normalizeRoadRef hyphenates
 * into the form roads.js reads. Sum miles per ref so the label names the road
 * that carries the route, not the first slip road off the driveway.
 * @returns {{key:string, miles:number}[]} longest first
 */
export function tripRoads(trip) {
  const miles = new Map();
  for (const leg of trip?.legs ?? []) {
    for (const m of leg.maneuvers ?? []) {
      const len = Number.isFinite(m.length) ? m.length : 0;
      if (len <= 0) continue;
      const seen = new Set();
      for (const name of m.street_names ?? []) {
        for (const s of roadShields(normalizeRoadRef(name))) {
          if (seen.has(s.key)) continue; // a concurrency counts its miles once per maneuver
          seen.add(s.key);
          miles.set(s.key, (miles.get(s.key) ?? 0) + len);
        }
      }
    }
  }
  return [...miles.entries()]
    .map(([key, mi]) => ({ key, miles: mi }))
    .sort((a, b) => b.miles - a.miles);
}

/**
 * "via I-90" / "via US-14 · WY-16". Only roads carrying a real share of the
 * ride earn a mention — otherwise every option is labelled with the same
 * three ramps and the labels stop telling them apart.
 */
export function viaLabel(trip, totalMiles, { top = 2, minShare = 0.15 } = {}) {
  const roads = tripRoads(trip);
  const floor = Math.max(1, (totalMiles || 0) * minShare);
  const kept = roads.filter((r) => r.miles >= floor).slice(0, top);
  return kept.map((r) => r.key).join(' · ');
}

// ---- is this the same road? ----

// A coarse grid cell per point: 2 decimal places is ~1.1 km, wide enough that
// GPS-grade shape differences on one road collapse to the same cells, narrow
// enough that two roads a few miles apart never do.
//
// The cells are laid down ALONG the line, not merely at its vertices. Routers
// hand back the same road at wildly different vertex densities — a straight
// interstate run can be two points a hundred miles apart while its alternate
// is sampled every few hundred yards — and a vertex-only set then skips most
// of the cells the denser one hits. Measured on the identical road sampled 60
// vs 140 ways: 0.34 overlap, i.e. "two different roads". Walking the segments
// makes the set a property of the ROAD rather than of how it was encoded.
const CELL = 0.01;
const cellsOf = (geometry) => {
  const set = new Set();
  const g = geometry ?? [];
  const put = (lat, lng) => set.add(`${lat.toFixed(2)},${lng.toFixed(2)}`);
  for (let i = 0; i < g.length; i++) {
    const [lng, lat] = g[i];
    put(lat, lng);
    const next = g[i + 1];
    if (!next) continue;
    const dLat = next[1] - lat;
    const dLng = next[0] - lng;
    // half a cell per step, so no cell on the segment can be stepped over
    const span = Math.max(Math.abs(dLat), Math.abs(dLng) * Math.cos((lat * Math.PI) / 180));
    const steps = Math.ceil(span / (CELL / 2));
    for (let s = 1; s < steps; s++) put(lat + (dLat * s) / steps, lng + (dLng * s) / steps);
  }
  return set;
};

/**
 * How much of the shorter road the two share, 0–1. Deliberately measured
 * against the SHORTER one: a detour that adds fifty miles to an otherwise
 * identical route is a different option, and this still reports it as such,
 * while a route that merely trims a corner is not.
 */
export function roadOverlap(a, b) {
  const A = a instanceof Set ? a : cellsOf(a);
  const B = b instanceof Set ? b : cellsOf(b);
  if (!A.size || !B.size) return 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  let shared = 0;
  for (const c of small) if (big.has(c)) shared++;
  return shared / small.size;
};

const SAME_ROAD = 0.85;

// ---- the list ----

/**
 * @param {object} o
 * @param {{lat,lng,heading?}} o.start
 * @param {{lat,lng}[]} o.stops        intermediate stops, in order (may be empty)
 * @param {{lat,lng}} o.end
 * @param {boolean} [o.avoidTolls]
 * @param {string[]} [o.styles]
 * @param {AbortSignal} [o.signal]
 * @param {number} [o.pace]            the trip's group-pace multiplier
 * @param {number} [o.maxAlternates]   extra roads beyond the style answers
 * @returns {Promise<Array>} options, best-of-each-style first, then alternates
 */
export async function routeOptions({
  start, stops = [], end, avoidTolls = false, styles = ROUTE_STYLES.map((s) => s.id),
  signal, pace = 1, maxAlternates = 2,
}) {
  if (!start || !end) throw new Error('need a start and a destination');
  const wps = [...stops, end];
  // Styles are asked in parallel: three requests, one screen. A style that
  // fails (or is superseded) drops out rather than failing the whole list —
  // one road is still a usable answer.
  const settled = await Promise.allSettled(styles.map(async (style) => ({
    style,
    trips: await valhallaTrips(start, wps, { style, avoidTolls }, { signal }),
  })));
  if (signal?.aborted) throw (signal.reason ?? new Error('aborted'));
  const got = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!got.length) {
    const reason = settled.find((s) => s.status === 'rejected')?.reason;
    throw reason instanceof Error ? reason : new Error('no route');
  }

  const paced = (minutes) => minutes * (pace || 1);
  const mk = (style, t, kind) => ({
    style,
    kind, // 'style' | 'alternate'
    miles: t.miles,
    minutes: paced(t.minutes),
    geometry: t.geometry,
    trip: t.trip,
    via: viaLabel(t.trip, t.miles),
    cells: cellsOf(t.geometry),
    prefs: normalizeRoutePrefs({ style, avoidTolls }),
  });

  // Each style's own answer. Quick is answered with the fastest road of its
  // set — see the note at the top of this file.
  const picks = [];
  const spare = [];
  for (const { style, trips } of got) {
    if (!trips.length) continue;
    const ordered = style === 'quick'
      ? [...trips].sort((a, b) => a.minutes - b.minutes)
      : trips;
    picks.push(mk(style, ordered[0], 'style'));
    for (const t of ordered.slice(1)) spare.push(mk(style, t, 'alternate'));
  }

  // Merge. A road that two styles both land on is ONE option wearing both
  // labels — that is the useful fact ("there is only one sensible way"), not a
  // duplicate to hide.
  const out = [];
  const place = (opt) => {
    const hit = out.find((o) => roadOverlap(o.cells, opt.cells) >= SAME_ROAD);
    if (!hit) { out.push({ ...opt, styles: [opt.style] }); return; }
    if (opt.kind === 'style' && !hit.styles.includes(opt.style)) {
      hit.styles.push(opt.style);
      hit.kind = 'style';
      // keep the kinder measurement of the same road
      if (opt.minutes < hit.minutes) { hit.minutes = opt.minutes; hit.miles = opt.miles; }
    }
  };
  for (const p of picks) place(p);
  // An alternate earns its row unless it is COMPREHENSIVELY worse. Measured
  // live on MN → Rapid City, the raw merge offered a 681 mi / 13.96 h road and
  // a 696 mi / 14.20 h road alongside a Back roads answer of 604 mi / 12.19 h
  // — around 13% longer and 15% slower, so nothing on the screen could make
  // one of them the right pick.
  //
  // The margin matters. Plain dominance ("worse on both axes") deletes the
  // Google-style alternates the rider asked to see: on that same route a 585.5
  // mi / 8.80 h road loses to I-90 on both counts by 1.5% and 2.5%, and that
  // is exactly the kind of near-tie a directions screen exists to show. Only a
  // road beaten on BOTH axes by more than a tenth is dropped.
  const MARGIN = 1.1;
  const dominated = (opt) => picks.some((p) => p.miles * MARGIN <= opt.miles && p.minutes * MARGIN <= opt.minutes);
  for (const s of spare.sort((a, b) => a.minutes - b.minutes)) {
    if (dominated(s)) continue;
    if (out.filter((o) => o.kind === 'alternate').length >= maxAlternates) break;
    place(s);
  }

  const fastest = Math.min(...out.map((o) => o.minutes));
  const shortest = Math.min(...out.map((o) => o.miles));
  return out.map((o, i) => {
    const { cells, ...rest } = o;
    return {
      ...rest,
      id: `${o.styles.join('+')}:${i}`,
      label: o.kind === 'style' ? o.styles.map(styleLabel).join(' · ') : 'Alternate',
      fastest: o.minutes <= fastest + 0.5,
      shortest: o.miles <= shortest + 0.5,
      deltaMinutes: o.minutes - fastest,
      deltaMiles: o.miles - shortest,
    };
  }).sort((a, b) => {
    // style answers first (they are the choice being offered), then alternates
    if ((a.kind === 'style') !== (b.kind === 'style')) return a.kind === 'style' ? -1 : 1;
    if (a.kind === 'style') {
      const rank = (o) => Math.min(...o.styles.map((s) => styles.indexOf(s)));
      return rank(a) - rank(b);
    }
    return a.minutes - b.minutes;
  });
}

// Trip engine: pure functions that recompute metrics and warnings from trip state.
// This is the "logic engine" — every edit re-runs through here so the plan stays honest.

export const DEFAULT_RANGE = { comfort: 180, absolute: 200, mpg: 45 }; // typical loaded cruiser
const AVG_MOVING_MPH = 45; // blended two-lane / interstate / park-traffic average
const LONG_DAY_HOURS = 12;

export const tripRange = (trip) => ({ ...DEFAULT_RANGE, ...(trip?.meta?.range ?? {}) });

// Group pace: planned riding is slower than the router's solo car — staggered
// formation, re-forms after stops, the slowest rider sets the speed. It lives
// on the trip (meta.pace, a duration multiplier: 1.0 solo, ~1.15 for a big
// group) and is applied wherever routed durations are consumed — never baked
// into the route cache, so changing it retimes the plan instantly.
export const DEFAULT_PACE = 1.08;
export function tripPace(trip) {
  const p = Number(trip?.meta?.pace);
  return Number.isFinite(p) && p >= 0.8 && p <= 1.6 ? p : DEFAULT_PACE;
}

export function haversineMiles(a, b) {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Estimate miles for a day. Prefers routed distances (from OSRM cache) keyed by
// waypoint-pair; falls back to the documented mile markers; last resort haversine * 1.25.
export function dayMiles(day, routedLegs) {
  const wps = day.waypoints;
  if (wps.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < wps.length - 1; i++) {
    const key = legKey(wps[i], wps[i + 1]);
    const routed = routedLegs?.[key];
    if (routed?.miles != null) {
      total += routed.miles;
    } else {
      const docDelta = (wps[i + 1].mile ?? 0) - (wps[i].mile ?? 0);
      total += docDelta > 0 ? docDelta : haversineMiles(wps[i], wps[i + 1]) * 1.25;
    }
  }
  return Math.round(total);
}

export function dayRideHours(day, routedLegs) {
  const wps = day.waypoints;
  let seconds = 0;
  let unrouted = 0;
  for (let i = 0; i < wps.length - 1; i++) {
    const routed = routedLegs?.[legKey(wps[i], wps[i + 1])];
    if (routed?.seconds != null) seconds += routed.seconds;
    else unrouted += (wps[i + 1].mile ?? 0) - (wps[i].mile ?? 0) > 0
      ? (wps[i + 1].mile - wps[i].mile)
      : haversineMiles(wps[i], wps[i + 1]) * 1.25;
  }
  return seconds / 3600 + unrouted / AVG_MOVING_MPH;
}

export function legKey(a, b) {
  return `${a.lat.toFixed(4)},${a.lng.toFixed(4)}|${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
}

// A day's prose is written ABOUT a route: "US-212 to the WY-296 junction,
// Chief Joseph down to WY-120". Change the stops and the words keep their
// old confidence while describing a ride nobody is taking. This fingerprint
// is what a summary is stamped against (day.summaryFor) so the panel can say
// so. Stops in order, id + name + position at 3 decimals (~110 m) — a marker
// nudged inside a parking lot is not a new route; a stop added, removed,
// reordered, renamed, or moved down the road is.
export function routeFingerprint(day) {
  return (day?.waypoints ?? [])
    .map((w) => {
      const at = Number.isFinite(w.lat) && Number.isFinite(w.lng)
        ? `${w.lat.toFixed(3)},${w.lng.toFixed(3)}` : '—';
      return `${w.id}@${at}#${(w.name ?? '').trim().toLowerCase()}`;
    })
    .join('|');
}

// True when the day carries prose that was stamped against a DIFFERENT route.
// Unstamped days (seed data, freshly generated trips, anything never edited)
// read as fine: the flag is for drift we can prove, not for suspicion.
export function summaryIsStale(day) {
  if (!day?.summary?.trim() || !day.summaryFor) return false;
  return day.summaryFor !== routeFingerprint(day);
}

// Project a position onto a coordinate chain: the nearest segment, the
// fraction along it, and the offset in miles. Shared by Ride Mode (plan
// position, off-route checks) and the speed-limit road matcher.
export function projectOnChain(chain, pos) {
  let best = null;
  const kx = Math.cos((pos.lat * Math.PI) / 180) * 69.17;
  const ky = 69.17;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const ax = (a.lng - pos.lng) * kx; const ay = (a.lat - pos.lat) * ky;
    const bx = (b.lng - pos.lng) * kx; const by = (b.lat - pos.lat) * ky;
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx; const py = ay + t * dy;
    const d = Math.sqrt(px * px + py * py);
    if (!best || d < best.off) best = { i, f: t, off: d };
  }
  return best;
}

// ---- direction-aware projection ----
// On an out-and-back day the routed chain carries the same road TWICE, the
// two copies within GPS noise of each other — a plain nearest-segment search
// picks between them arbitrarily, and every consumer downstream inherits the
// flip: the traveled-line split detaches from the puck, the snapped heading
// reverses (the camera spins), and the along-route position leaps onto the
// return leg, resolving stops the bike never reached (field-caught riding
// into Crazy Horse, Aug 12 2026). This variant keeps the same scan but,
// among segments in distance CONTENTION with the nearest, prefers the one
// that agrees with the bike's heading and with where the bike just was.
// The penalties only ever reorder contenders — the returned `off` is always
// the raw distance to the chosen segment, so off-route thresholds and snap
// gates read exactly as before.
const CONTEND_MI = 0.03;      // contention band above the nearest hit (~50 m)
const HEADING_TOL_DEG = 100;  // beyond this the segment points the wrong way
const HEADING_PENALTY_MI = 0.06;
const CONTINUITY_WINDOW_MI = 0.4; // plausible along-travel between usable fixes
const CONTINUITY_PENALTY_MI = 0.12; // outranks heading: hairpins briefly align with the other copy
export function projectOnChainDirected(chain, pos, { heading = null, nearMi = null, cum = null, afterMi = null } = {}) {
  if (!chain || chain.length < 2 || !pos) return null;
  const kx = Math.cos((pos.lat * Math.PI) / 180) * 69.17;
  const ky = 69.17;
  // pass 1: every segment's distance + along-position; remember the nearest
  const segs = new Array(chain.length - 1);
  let minOff = Infinity;
  let cumd = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i];
    const b = chain[i + 1];
    const ax = (a.lng - pos.lng) * kx; const ay = (a.lat - pos.lat) * ky;
    const bx = (b.lng - pos.lng) * kx; const by = (b.lat - pos.lat) * ky;
    const dx = bx - ax; const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx; const py = ay + t * dy;
    const d = Math.sqrt(px * px + py * py);
    const segLen = cum ? cum[i + 1] - cum[i] : Math.sqrt(len2);
    const along = (cum ? cum[i] : cumd) + t * segLen;
    segs[i] = { d, t, along };
    cumd += segLen;
    if (d < minOff) minOff = d;
  }
  // pass 2: score the contenders
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.d > minOff + CONTEND_MI) continue;
    let aligned = true;
    if (heading != null) {
      const a = chain[i];
      const b = chain[i + 1];
      const brg = (Math.atan2((b.lng - a.lng) * Math.cos((pos.lat * Math.PI) / 180), b.lat - a.lat) * 180) / Math.PI;
      const diff = Math.abs((((brg - heading) % 360) + 540) % 360 - 180);
      aligned = diff <= HEADING_TOL_DEG;
    }
    let score;
    if (afterMi != null) {
      // afterMi selects by ROUTE ORDER instead of distance: the first
      // contender at-or-past this along-position — or, when every one is
      // behind, the LAST, so "passed the stop" only reads true once the
      // bike is past even the final drive-by. Heading still gates it: a
      // loop can ride the same stretch the same DIRECTION twice (morning
      // out and the midnight return both southbound on US-385 — field bug,
      // where distance+heading alone locked the return copy and the day
      // read "7 mi left" at 11 AM), and there earliest-aligned is the only
      // safe cold answer.
      score = s.along >= afterMi ? s.along : 1e6 - s.along;
      if (!aligned) score += 1e7;
    } else {
      score = s.d;
      if (!aligned) score += HEADING_PENALTY_MI;
      if (nearMi != null && Math.abs(s.along - nearMi) > CONTINUITY_WINDOW_MI) score += CONTINUITY_PENALTY_MI;
    }
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && best && s.along < best.along)) {
      bestScore = score;
      best = { i, f: s.t, off: s.d, along: s.along, aligned };
    }
  }
  return best;
}

// A stateful wrapper for tracking one moving position along one chain across
// GPS fixes: remembers the last along-position for the continuity preference,
// forgets it when the chain changes / the memory goes stale / the bike
// teleports, and self-heals a wrong-copy lock — three consecutive fixes
// tracking a segment that opposes the bike's actual heading mean the initial
// (headingless) acquisition latched the wrong copy of an overlapping road,
// so the memory drops and heading re-acquires the right one immediately.
// Results are memoized on (chain, pos) identity: re-renders re-read for free,
// and a repeat call can never advance the wrong-way counter twice.
const CURSOR_STALE_MS = 15000;
const CURSOR_JUMP_MI = 1.5;
const WRONG_WAY_FIXES = 3;
export function chainCursor() {
  let lastChain = null;
  let lastPos = null;
  let lastOut = null;
  let alongMi = null;
  let atMs = 0;
  let wrongWay = 0;
  return {
    project(chain, pos, { heading = null, cum = null } = {}) {
      if (!chain || chain.length < 2 || !pos) return null;
      if (chain === lastChain && pos === lastPos) return lastOut;
      const now = pos.at ?? Date.now();
      if (chain !== lastChain) { alongMi = null; wrongWay = 0; }
      else if (alongMi != null
        && ((atMs && now - atMs > CURSOR_STALE_MS)
          || (lastPos && haversineMiles(lastPos, pos) > CURSOR_JUMP_MI))) {
        alongMi = null;
        wrongWay = 0;
      }
      // Cold acquisition is the unguarded moment: at a point the chain
      // visits twice, distance can't separate the copies — and heading
      // can't either when a loop rides the same stretch the same direction
      // twice (parked at the shared lodging, or southbound on the road the
      // return also takes southbound). Take the EARLIEST heading-compatible
      // copy: reading "less ridden" at worst under-reports progress, which
      // self-heals where the copies diverge; locking a late copy eats the
      // day (visited stops, "7 mi left" at 11 AM — both field-caught).
      const cold = alongMi == null ? { afterMi: 0 } : {};
      let r = projectOnChainDirected(chain, pos, { heading, nearMi: alongMi, cum, ...cold });
      if (r && heading != null && !r.aligned) {
        wrongWay += 1;
        if (wrongWay >= WRONG_WAY_FIXES) {
          wrongWay = 0;
          alongMi = null;
          r = projectOnChainDirected(chain, pos, { heading, nearMi: null, cum, afterMi: 0 });
        }
      } else if (r) {
        wrongWay = 0;
      }
      lastChain = chain;
      lastPos = pos;
      lastOut = r;
      if (r) { alongMi = r.along; atMs = now; }
      return r;
    },
  };
}

// ---- line-progress: the metric MapLibre gradients actually use ----
// A `line-gradient` stop is a fraction of the line's WEB-MERCATOR length, not
// of its ground length: geojson-vt projects the line before it measures it
// (projectX = lng/360, projectY = the mercator log), so every mile of road
// counts as mile / cos(latitude). Handing such a gradient a ground-mile
// fraction therefore MISPLACES it on any route that gains or loses latitude —
// no error at either end of the line, worst in the middle, and growing with
// every mile through the first half of the day. Field-caught riding I-90 out
// of Sturgis toward Sheridan (Aug 14, 2026): the traveled/ahead split sat
// 1.4 mi ahead of the puck and kept pulling away ("route marker keeps getting
// further from my marker"); by mid-route it would have been 2.4 mi. Measure
// the chain the way MapLibre will and the split rides ON the bike.
const mercatorY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
};
export function mercatorCum(chain) {
  const mcum = [0];
  for (let i = 1; i < chain.length; i++) {
    const dx = (chain[i].lng - chain[i - 1].lng) / 360;
    const dy = mercatorY(chain[i].lat) - mercatorY(chain[i - 1].lat);
    mcum.push(mcum[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  return { mcum, mtotal: mcum[mcum.length - 1] || 1 };
}

// Segment index + fraction — what every projection in this file returns — to
// the 0..1 line-progress of that point. Interpolating inside one segment is
// safe: the projection's scale is constant across a few hundred feet.
export function lineProgressAt({ mcum, mtotal } = {}, i, f = 0) {
  if (!mcum || !Number.isInteger(i) || i < 0 || i > mcum.length - 2) return null;
  return (mcum[i] + f * (mcum[i + 1] - mcum[i])) / mtotal;
}

// Where a new stop belongs in DAY ORDER, read off the day's ROUTED line:
// project the stop and every waypoint onto the geometry and insert before
// the first stop the route reaches after it. The straight-line splice
// (bestInsertIndex below) can't tell the two passes of an out-and-back
// apart and ignores what the road does between stops — field-caught when a
// plan-side add landed in the wrong half of a loop day. Waypoints project
// monotonically (each at-or-after the previous one's along), the new stop
// at its FIRST drive-by. Returns null when the stop is a genuine detour
// (> 5 mi off the route) or there is no usable geometry — callers fall back
// to the straight-line splice.
export function insertIndexOnRoute(waypoints, chain, pt, cumIn = null) {
  if (!chain || chain.length < 2 || !waypoints || waypoints.length < 2 || !pt) return null;
  let cum = cumIn;
  if (!cum) {
    cum = [0];
    for (let i = 1; i < chain.length; i++) cum.push(cum[i - 1] + haversineMiles(chain[i - 1], chain[i]));
  }
  const p = projectOnChainDirected(chain, pt, { cum, afterMi: 0 });
  if (!p || p.off > 5) return null;
  let prev = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const w = waypoints[i];
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lng)) continue;
    const wp = projectOnChainDirected(chain, w, { cum, afterMi: prev });
    if (!wp) continue;
    if (wp.along >= p.along) return i;
    prev = wp.along;
  }
  // never past the day's destination — the route ends there
  return waypoints.length - 1;
}

// Cheapest place to splice a new point into an existing waypoint sequence.
export function bestInsertIndex(waypoints, pt) {
  if (waypoints.length < 2) return waypoints.length;
  let best = 1;
  let bestCost = Infinity;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const cost = haversineMiles(a, pt) + haversineMiles(pt, b) - haversineMiles(a, b);
    if (cost < bestCost) { bestCost = cost; best = i + 1; }
  }
  return best;
}

// Fuel analysis: walk the waypoints, measure gaps between fuel stops.
export function fuelGaps(day, routedLegs) {
  const wps = day.waypoints;
  const gaps = [];
  let sinceFuel = 0;
  let fromName = wps[0]?.name ?? 'start';
  for (let i = 0; i < wps.length - 1; i++) {
    const key = legKey(wps[i], wps[i + 1]);
    const routed = routedLegs?.[key];
    const docDelta = (wps[i + 1].mile ?? 0) - (wps[i].mile ?? 0);
    const legMiles = routed?.miles ?? (docDelta > 0 ? docDelta : haversineMiles(wps[i], wps[i + 1]) * 1.25);
    sinceFuel += legMiles;
    const next = wps[i + 1];
    if (next.fuel || i === wps.length - 2) {
      gaps.push({ from: fromName, to: next.name, miles: Math.round(sinceFuel) });
      sinceFuel = 0;
      fromName = next.name;
    }
  }
  return gaps;
}

export function dayWarnings(day, routedLegs, range = DEFAULT_RANGE, prevDay = null) {
  const warnings = [];
  // A day that starts away from where yesterday ended: the connecting miles
  // belong to no day (totals quietly under-count) and the trip map's line
  // visibly breaks there. AI restructures produce this when the same town
  // geocodes to two different pins on either side of the boundary.
  const prevEnd = prevDay?.waypoints?.[prevDay.waypoints.length - 1];
  const firstWp = day.waypoints?.[0];
  if (prevEnd && firstWp && Number.isFinite(prevEnd.lat) && Number.isFinite(firstWp.lat)) {
    const bGap = haversineMiles(prevEnd, firstWp);
    if (bGap > 2) {
      warnings.push({ level: 'warn', text: `Starts ${Math.round(bGap)} mi from where ${prevDay.dow} ends (${prevEnd.name} → ${firstWp.name}) — those miles belong to no day. Re-pick one of the two stops so the days connect.` });
    }
  }
  const gaps = fuelGaps(day, routedLegs);
  for (const g of gaps) {
    if (g.miles > range.absolute) {
      warnings.push({ level: 'danger', text: `Fuel gap ${g.miles} mi (${g.from} → ${g.to}) exceeds the ${range.absolute}-mi absolute range.` });
    } else if (g.miles > range.comfort) {
      warnings.push({ level: 'warn', text: `Fuel gap ${g.miles} mi (${g.from} → ${g.to}) is past the ${range.comfort}-mi comfort range.` });
    }
  }
  const rideH = dayRideHours(day, routedLegs);
  const stopH = estimatedStopHours(day);
  if (rideH + stopH > LONG_DAY_HOURS) {
    warnings.push({ level: 'warn', text: `Estimated ${(rideH + stopH).toFixed(1)} h door-to-door (${rideH.toFixed(1)} riding + ${stopH.toFixed(1)} stopped). Packed day — know your levers.` });
  }
  if (day.lodging?.status === 'reserve') {
    warnings.push({ level: 'danger', text: `Lodging not booked: ${day.lodging.name}. Reserve now.` });
  }
  return warnings;
}

export function estimatedStopHours(day) {
  let h = 0;
  h += (day.photos?.length ?? 0) * 0.25;
  h += (day.meals?.filter((m) => m.meal !== 'breakfast').length ?? 0) * 1.0;
  for (const m of day.modules ?? []) {
    if (!m.enabled) continue;
    const match = /(\d+(?:\.\d+)?)\s*(?:hour|hr)/i.exec(m.duration ?? '');
    h += match ? parseFloat(match[1]) : 1;
  }
  return h;
}

export function tripSummary(trip, routedLegsByDay) {
  const days = trip.days;
  const range = tripRange(trip);
  let miles = 0;
  const perDay = days.map((d, i) => {
    const m = dayMiles(d, routedLegsByDay?.[d.id]);
    miles += m;
    return {
      id: d.id,
      miles: m,
      rideHours: dayRideHours(d, routedLegsByDay?.[d.id]),
      stopHours: estimatedStopHours(d),
      warnings: dayWarnings(d, routedLegsByDay?.[d.id], range, i > 0 ? days[i - 1] : null),
    };
  });
  const unbooked = days.filter((d) => d.lodging?.status === 'reserve').length;
  return { totalMiles: miles, perDay, unbooked };
}

// Compact plain-text digest of the whole trip + engine analysis, for the AI optimizer.
// How a day should be named anywhere a human will read it.
export const dayLabel = (d) => `${d.dow} ${fmtShortDate(d.date)} · ${d.title}`;
const fmtShortDate = (iso) => {
  const [, m, day] = (iso ?? '').split('-');
  return m ? `${Number(m)}/${Number(day)}` : (iso ?? '');
};

// What the optimizer actually needs to reason about and edit. Photo essays,
// operations checklists, and field notes are read-only prose no op can touch —
// they only slow the model down before it starts answering.
export function compactTripForModel(trip) {
  return {
    meta: trip.meta,
    days: trip.days.map((d) => ({
      id: d.id, label: dayLabel(d),
      dow: d.dow, date: d.date, title: d.title, phase: d.phase, anchor: d.anchor,
      depart: d.depart, summary: d.summary,
      constraints: d.constraints ?? [], gates: d.gates ?? [],
      waypoints: d.waypoints,
      meals: d.meals ?? [],
      lodging: d.lodging,
      modules: (d.modules ?? []).map((m) => ({ id: m.id, name: m.name, duration: m.duration, enabled: m.enabled })),
    })),
    reserveNow: (trip.reserveNow ?? []).map((r) => ({ id: r.id, name: r.name, when: r.when, done: r.done })),
  };
}

export function tripDigest(trip, routedLegsByDay) {
  const lines = [];
  lines.push(`${trip.meta.title} — ${trip.meta.riders} riders, start ${trip.meta.startDate}. Fuel rule: ${trip.meta.fuelRule ?? 'fill at half tank on long stretches'}`);
  for (const d of trip.days) {
    const m = dayMiles(d, routedLegsByDay?.[d.id]);
    const rh = dayRideHours(d, routedLegsByDay?.[d.id]);
    const sh = estimatedStopHours(d);
    lines.push('');
    // Leg name first, id last and labelled — the model quotes what it reads,
    // and riders do not think in ids.
    lines.push(`## ${dayLabel(d)} [phase:${d.phase}]${d.anchor ? ' [ANCHOR DAY]' : ''} (id for ops only: ${d.id})`);
    lines.push(`~${m} mi, ~${rh.toFixed(1)}h riding + ~${sh.toFixed(1)}h stopped. Depart ${d.depart}.`);
    if (d.constraints?.length) lines.push(`Constraints: ${d.constraints.join(' | ')}`);
    lines.push(`Waypoints: ${d.waypoints.map((w) => `${w.id}:${w.name}${w.fuel ? ' [FUEL]' : ''}`).join(' → ')}`);
    if (d.meals?.length) lines.push(`Meals: ${d.meals.map((x) => `${x.meal}: ${x.name}`).join(' · ')}`);
    if (d.modules?.length) lines.push(`Modules: ${d.modules.map((x) => `${x.id}:${x.name} (${x.enabled ? 'ON' : 'off'})`).join(' · ')}`);
    if (d.lodging) lines.push(`Lodging: ${d.lodging.name} [${d.lodging.status}]`);
    const warns = dayWarnings(d, routedLegsByDay?.[d.id], tripRange(trip), trip.days[trip.days.indexOf(d) - 1] ?? null);
    for (const w of warns) lines.push(`⚠ ${w.text}`);
  }
  lines.push('');
  lines.push(`Bike range: comfort ${tripRange(trip).comfort} mi, absolute ${tripRange(trip).absolute} mi, ${tripRange(trip).mpg} mpg.`);
  if (trip.reserveNow?.length) lines.push(`Unbooked reservations: ${trip.reserveNow.filter((r) => !r.done).map((r) => r.name).join('; ') || 'none'}`);
  return lines.join('\n');
}

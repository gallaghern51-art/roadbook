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

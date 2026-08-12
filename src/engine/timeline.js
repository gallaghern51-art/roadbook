// Timeline + feasibility engine.
// Simulates each day minute-by-minute: departure → leg durations (routed) →
// dwell at each stop → ETAs → hard-gate checks → feasibility score.

import { legKey, haversineMiles, fuelGaps, DEFAULT_RANGE, tripRange } from './tripEngine.js';

export const DWELL_DEFAULT = { start: 0, via: 5, fuel: 15, photo: 20, end: 0 };
const AVG_MPH = 45;
const DARK_MIN = 20 * 60 + 30; // default dusk when the trip doesn't set one

export function parseTime(str, fallbackMin = 8 * 60) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(str || '');
  if (!m) return fallbackMin;
  let h = +m[1];
  const min = +m[2];
  const ap = m[3]?.toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

export function fmtTime(mins) {
  mins = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ap = h24 >= 12 ? 'PM' : 'AM';
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

export function fmtDur(mins) {
  mins = Math.round(mins);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function dwellFor(w) {
  return Number.isFinite(w.dwell) ? w.dwell : (DWELL_DEFAULT[w.kind] ?? 5);
}

// Per-waypoint schedule: { id, arrive, depart, legMiles, legMin, dwell }
/**
 * Where the plan says you should be at `clockMin` — the other half of "are we
 * behind?". A time delta alone does not tell a rider anything actionable; this
 * turns it into ground: which leg you should be on and how far along.
 *
 * Derived entirely from the timeline, so it re-answers itself whenever the route
 * changes (stops moved, departure retimed, routing refreshed) with nothing to
 * invalidate by hand.
 *
 * @returns {{miles:number, stopIndex:number, atStop:boolean}|null}
 *   miles     — planned distance covered by now
 *   stopIndex — the stop you should be at or heading to
 *   atStop    — true while the plan has you parked there (dwell), not moving
 */
export function planTargetAt(day, tl, clockMin) {
  const stops = tl?.stops;
  if (!stops?.length) return null;

  // before rolling out: nothing covered yet
  if (clockMin <= stops[0].depart) return { miles: 0, stopIndex: 0, atStop: true };

  let miles = 0;
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1];
    const s = stops[i];
    // in transit on the leg into stop i
    if (clockMin < s.arrive) {
      const legMin = s.arrive - prev.depart;
      const f = legMin > 0 ? Math.max(0, Math.min(1, (clockMin - prev.depart) / legMin)) : 0;
      return { miles: miles + f * s.legMiles, stopIndex: i, atStop: false };
    }
    miles += s.legMiles;
    // parked at stop i for its dwell
    if (clockMin < s.depart) return { miles, stopIndex: i, atStop: true };
  }
  // past the last arrival — the day is done on paper
  return { miles, stopIndex: stops.length - 1, atStop: true };
}

export function dayTimeline(day, routedLegs) {
  const departMin = parseTime(day.depart);
  const wps = day.waypoints;
  const stops = [];
  let t = departMin;
  for (let i = 0; i < wps.length; i++) {
    const w = wps[i];
    let legMiles = 0;
    let legMin = 0;
    if (i > 0) {
      const prev = wps[i - 1];
      const r = routedLegs?.[legKey(prev, w)];
      const docDelta = (w.mile ?? 0) - (prev.mile ?? 0);
      legMiles = r?.miles ?? (docDelta > 0 ? docDelta : haversineMiles(prev, w) * 1.25);
      legMin = r?.seconds != null ? r.seconds / 60 : (legMiles / AVG_MPH) * 60;
    }
    const arrive = t + legMin;
    const dwell = i === 0 || i === wps.length - 1 ? 0 : dwellFor(w);
    const depart = arrive + dwell;
    stops.push({ id: w.id, arrive, depart, legMiles, legMin, dwell });
    t = depart;
  }
  const endMin = stops.length ? stops[stops.length - 1].arrive : departMin;
  return { departMin, stops, endMin, durMin: endMin - departMin };
}

// Feasibility for one day: gate checks, fuel range, day length, darkness, lodging.
// darkMin comes from trip.meta.dusk — riding season and latitude move sunset by
// hours, so "after dark" is the trip's own fact, not the engine's.
export function dayFeasibility(day, routedLegs, range = DEFAULT_RANGE, darkMin = DARK_MIN) {
  const tl = dayTimeline(day, routedLegs);
  const issues = [];
  let score = 100;

  for (const g of day.gates ?? []) {
    const stop = tl.stops.find((s) => s.id === g.waypointId);
    if (!stop) continue;
    const gateMin = parseTime(g.by);
    const margin = Math.round(gateMin - stop.arrive);
    if (margin < 0) {
      score -= 25;
      issues.push({ level: 'fail', text: `${g.label}: ETA ${fmtTime(stop.arrive)} misses the ${g.by} gate by ${fmtDur(-margin)}.` });
    } else if (margin < 20) {
      score -= 8;
      issues.push({ level: 'warn', text: `${g.label}: ETA ${fmtTime(stop.arrive)} — only ${fmtDur(margin)} of margin on the ${g.by} gate.` });
    } else {
      issues.push({ level: 'ok', text: `${g.label}: ETA ${fmtTime(stop.arrive)}, ${fmtDur(margin)} ahead of the ${g.by} gate.` });
    }
  }

  for (const gap of fuelGaps(day, routedLegs)) {
    if (gap.miles > range.absolute) {
      score -= 15;
      issues.push({ level: 'fail', text: `Fuel gap ${gap.miles} mi (${gap.from} → ${gap.to}) exceeds the ${range.absolute}-mi absolute range.` });
    } else if (gap.miles > range.comfort) {
      score -= 6;
      issues.push({ level: 'warn', text: `Fuel gap ${gap.miles} mi (${gap.from} → ${gap.to}) past the ${range.comfort}-mi comfort range.` });
    }
  }

  const durH = tl.durMin / 60;
  if (durH > 13) {
    score -= 12;
    issues.push({ level: 'warn', text: `${durH.toFixed(1)}h door-to-door — brutal for a group ride.` });
  } else if (durH > 11) {
    score -= 6;
    issues.push({ level: 'warn', text: `${durH.toFixed(1)}h door-to-door — long day, protect the stops that matter.` });
  }

  if (tl.endMin > darkMin && day.waypoints.length > 1) {
    score -= 8;
    issues.push({ level: 'warn', text: `Projected arrival ${fmtTime(tl.endMin)} — after dark (~${fmtTime(darkMin)}). Wildlife risk on rural two-lane.` });
  }

  if (day.lodging?.status === 'reserve') {
    score -= 10;
    issues.push({ level: 'fail', text: `Lodging not booked: ${day.lodging.name}.` });
  }

  return { score: Math.max(0, Math.round(score)), issues, timeline: tl };
}

export function gradeFor(score) {
  if (score >= 90) return 'A';
  if (score >= 78) return 'B';
  if (score >= 62) return 'C';
  if (score >= 45) return 'D';
  return 'F';
}

export function tripFeasibility(trip, routedLegsByDay) {
  const range = tripRange(trip);
  const darkMin = parseTime(trip.meta?.dusk, DARK_MIN);
  // A ridden day is history, not a call to action: mid-trip, the overall
  // grade scores only what is still ahead (each day keeps its row and its
  // own score — `past` lets the views mute them). Once the whole trip is
  // behind (or days carry no dates), all days count, as before.
  const today = new Date().toLocaleDateString('sv-SE');
  const perDay = trip.days.map((d) => ({
    id: d.id,
    past: !!d.date && d.date < today,
    ...dayFeasibility(d, routedLegsByDay?.[d.id], range, darkMin),
  }));
  const ahead = perDay.filter((p) => !p.past);
  const scored = ahead.length ? ahead : perDay;
  const overall = Math.round(scored.reduce((a, p) => a + p.score, 0) / Math.max(1, scored.length));
  return { perDay, overall, grade: gradeFor(overall), pastCount: ahead.length ? perDay.length - ahead.length : 0 };
}

// Plain-text feasibility digest appended to the AI context.
export function feasibilityDigest(trip, routedLegsByDay) {
  const lines = ['## FEASIBILITY STUDY (engine-computed)'];
  const f = tripFeasibility(trip, routedLegsByDay);
  lines.push(`Overall: ${f.overall}/100 (grade ${f.grade})${f.pastCount ? ` — remaining trip only; ${f.pastCount} day(s) already ridden` : ''}`);
  for (const d of trip.days) {
    const p = f.perDay.find((x) => x.id === d.id);
    const tl = p.timeline;
    lines.push(`${d.id} ${d.dow}: score ${p.score}, depart ${fmtTime(tl.departMin)}, end ~${fmtTime(tl.endMin)} (${fmtDur(tl.durMin)} door-to-door)`);
    for (const i of p.issues.filter((x) => x.level !== 'ok')) lines.push(`  ${i.level.toUpperCase()}: ${i.text}`);
  }
  return lines.join('\n');
}

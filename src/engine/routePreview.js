import { tripPace, tripSummary } from './tripEngine.js';
import { tripFeasibility } from './timeline.js';

const clean = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');

function routeLegs(routes = {}, pace = 1) {
  const out = {};
  for (const [dayId, route] of Object.entries(routes)) {
    out[dayId] = {};
    for (const [key, leg] of Object.entries(route?.legs ?? {})) {
      out[dayId][key] = Number.isFinite(leg?.seconds)
        ? { ...leg, seconds: leg.seconds * pace }
        : leg;
    }
  }
  return out;
}

function isLinkedToRoute(place, waypoints) {
  if (Number.isFinite(place?.lat) && Number.isFinite(place?.lng)) return true;
  if (place?.placeId && waypoints.some((w) => w.placeId === place.placeId)) return true;
  const name = clean(place?.name);
  if (name.length < 4) return false;
  return waypoints.some((w) => {
    const waypointName = clean(w.name);
    return waypointName.length >= 4 && (waypointName.includes(name) || name.includes(waypointName));
  });
}

// Commitment is inferred from facts Roadbook already owns. Bookings and hard
// gates are promises; everything else is held in the first route draft but can
// be researched as a replacement only after the rider asks for alternatives.
export function routeChangeInventory(trip) {
  const hard = [];
  const flexible = [];
  const unlinked = [];
  let preservedRouteStops = 0;

  for (const day of trip.days ?? []) {
    const waypoints = day.waypoints ?? [];
    const gateIds = new Set((day.gates ?? []).map((gate) => gate.waypointId));

    for (const gate of day.gates ?? []) {
      const waypoint = waypoints.find((w) => w.id === gate.waypointId);
      hard.push({ dayId: day.id, kind: 'gate', name: gate.label || waypoint?.name || 'Timed stop' });
    }

    if (day.lodging?.name) {
      const item = { dayId: day.id, kind: 'lodging', name: day.lodging.name, status: day.lodging.status ?? 'none' };
      if (day.lodging.status === 'booked') hard.push(item);
      else flexible.push(item);
      if (!isLinkedToRoute(day.lodging, waypoints)) unlinked.push(item);
    }

    for (const meal of day.meals ?? []) {
      if (!meal.name) continue;
      const item = { dayId: day.id, kind: 'food', name: meal.name, role: meal.meal };
      flexible.push(item);
      if (!isLinkedToRoute(meal, waypoints)) unlinked.push(item);
    }

    waypoints.slice(1, -1).forEach((waypoint) => {
      preservedRouteStops++;
      if (gateIds.has(waypoint.id)) return;
      flexible.push({
        dayId: day.id,
        kind: waypoint.fuel || waypoint.kind === 'fuel' ? 'fuel' : waypoint.kind === 'photo' ? 'attraction' : 'stop',
        name: waypoint.name,
        waypointId: waypoint.id,
      });
    });
  }

  for (const reservation of trip.reserveNow ?? []) {
    if (!reservation.done || !reservation.name) continue;
    // Booking-checklist entries are commitments even when an older trip does
    // not connect them to a waypoint id. Keep them visible to the AI handoff.
    hard.push({ kind: 'reservation', name: reservation.name });
  }

  const unique = (items) => [...new Map(items.map((item) => [`${item.dayId ?? ''}:${item.kind}:${clean(item.name)}`, item])).values()];
  return {
    hard: unique(hard),
    flexible: unique(flexible),
    unlinked: unique(unlinked),
    preservedRouteStops,
  };
}

export function analyzeRouteChange(trip, currentRoutes, candidateRoutes, prefs) {
  const pace = tripPace(trip);
  const currentLegs = routeLegs(currentRoutes, pace);
  const candidateLegs = routeLegs(candidateRoutes, pace);
  const currentSummary = tripSummary(trip, currentLegs);
  const candidateSummary = tripSummary(trip, candidateLegs);
  const currentFeas = tripFeasibility(trip, currentLegs);
  const candidateFeas = tripFeasibility(trip, candidateLegs);
  const inventory = routeChangeInventory(trip);

  const days = (trip.days ?? []).map((day) => {
    const before = currentSummary.perDay.find((item) => item.id === day.id);
    const after = candidateSummary.perDay.find((item) => item.id === day.id);
    const beforeWarnings = new Set((before?.warnings ?? []).map((warning) => warning.text));
    const introduced = (after?.warnings ?? []).filter((warning) => !beforeWarnings.has(warning.text));
    const deltaMiles = (after?.miles ?? 0) - (before?.miles ?? 0);
    const deltaMinutes = ((after?.rideHours ?? 0) - (before?.rideHours ?? 0)) * 60;
    return {
      id: day.id,
      label: `${day.dow ?? ''} ${day.date ?? ''}`.trim(),
      title: day.title,
      beforeMiles: before?.miles ?? 0,
      afterMiles: after?.miles ?? 0,
      deltaMiles,
      deltaMinutes,
      introduced,
      changed: Math.abs(deltaMiles) >= 2 || Math.abs(deltaMinutes) >= 5,
    };
  });

  const changedIds = new Set(days.filter((day) => day.changed).map((day) => day.id));
  const affectedFlexible = inventory.flexible.filter((item) => !item.dayId || changedIds.has(item.dayId));
  const currentRideMinutes = currentSummary.perDay.reduce((sum, day) => sum + day.rideHours * 60, 0);
  const candidateRideMinutes = candidateSummary.perDay.reduce((sum, day) => sum + day.rideHours * 60, 0);

  return {
    prefs,
    current: {
      miles: currentSummary.totalMiles,
      rideMinutes: currentRideMinutes,
      grade: currentFeas.grade,
      score: currentFeas.overall,
    },
    candidate: {
      miles: candidateSummary.totalMiles,
      rideMinutes: candidateRideMinutes,
      grade: candidateFeas.grade,
      score: candidateFeas.overall,
    },
    deltaMiles: candidateSummary.totalMiles - currentSummary.totalMiles,
    deltaMinutes: candidateRideMinutes - currentRideMinutes,
    introducedWarnings: days.flatMap((day) => day.introduced.map((warning) => ({ ...warning, dayId: day.id, day: day.label }))),
    changedDays: days.filter((day) => day.changed),
    inventory,
    affectedFlexible,
  };
}

export function routeReconciliationPrompt(trip, preview, styleLabel) {
  const locked = preview.analysis.inventory.hard.map((item) => item.name).slice(0, 18);
  const review = preview.analysis.affectedFlexible.map((item) => `${item.kind}: ${item.name}`).slice(0, 24);
  const prefs = preview.prefs;
  return `Research a constraint-aware change from ${trip.meta.routePrefs?.style ?? 'touring'} to ${styleLabel} for this existing trip.

This is NOT approval to change the trip yet. First present the rider with specific better-fit alternatives for the flexible food, fuel, lodging, and attraction stops affected by the new road corridor. Evaluate the hard-anchor corridor with Valhalla motorcycle routing and routePrefs ${JSON.stringify(prefs)}, then pass its returned searchAlongRouteId as routeOptionId to live Google Places Search Along Route for real businesses and opening hours. Re-evaluate the completed options in Valhalla. Preserve each stop's role and time slot.

Hard constraints — do not move or replace these: ${locked.length ? locked.join('; ') : 'trip start/end and all hard gates'}.
Flexible places to review: ${review.length ? review.join('; ') : 'the existing unbooked recommendations'}.

Keep booked lodging and overnight cities fixed. Keep every hard gate fixed. Fuel coverage remains a hard safety constraint even when the station is flexible. If a meal or lodging record changes, keep its corresponding route waypoint synchronized so the route actually visits it. Explain the per-day mileage, time, daylight, fuel-gap, and opening-hours effect. Let me choose replacements piece by piece. Only after I choose should you issue one atomic proposal that includes the routePrefs change.

<route_reconciliation_request>${JSON.stringify({ routePrefs: prefs })}</route_reconciliation_request>`;
}

// Editing a proposed route by hand — no model in the loop.
//
// Owner, Sep 20 2026: "if you recommend one dinner spot and they dont want to
// go there. they should be able to choose replace and then go to map and
// search area for food etc for the stop" — "i dont want to force people into
// lengthy full AI rebuilds".
//
// Until now every change to a proposed route was a planner turn. The pieces
// here let the rider replace a stop themselves: swap the place into the
// concept, re-measure the ROAD with the same model-free evaluator the planner
// uses, and keep every other option's comparison honest. The planner remains
// one tap away for the times a rider wants it to reason about the change.

// ---- the swap ----

/**
 * The concept with one stop replaced. The stop keeps its ROLE — a dinner stays
 * a dinner, a fuel stop stays a fuel stop, and its place in the order does not
 * move — only the place itself changes. Returns a new concept; never mutates.
 *
 * The replaced stop's measured figures are dropped rather than kept, because
 * they describe a road the concept no longer rides: `metrics` becomes null
 * until a re-measure lands, and the UI says "re-measuring" rather than showing
 * miles that are no longer true.
 */
import { mealOf, isEvening, settleEvenings } from './dayShape.js';

// Which stops Replace applies to: every one between the ends, and a hotel the
// trip ends at (settleEvenings folds a zero-mile last day into it, and a hotel
// is a business the rider may well want to swap — unlike their own start).
export function replaceableAt(locations, index) {
  const n = locations?.length ?? 0;
  if (!Number.isInteger(index) || index <= 0 || index >= n) return false;
  return index < n - 1 || locations[index]?.kind === 'lodging';
}

export function replaceConceptStop(concept, index, place) {
  const locations = concept?.locations ?? [];
  if (!replaceableAt(locations, index)) {
    // The ends are the trip's start and destination — not a "stop" to swap.
    throw new Error('only an intermediate stop can be replaced');
  }
  if (!Number.isFinite(place?.lat) || !Number.isFinite(place?.lng)) {
    throw new Error('the replacement has no location');
  }
  const old = locations[index];
  const placeId = place.placeId ?? (place.source === 'google' ? place.id : null);
  const next = {
    ...old, // role, dwell, day position — everything that is not the place
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    detail: place.detail ?? '',
    // Identity follows the NEW place, never the old one: a verified place
    // carries its id; anything else is explicitly not verified, so the old
    // stop's ✓ can never ride along onto a place nobody checked.
    ...(placeId ? { placeId, verified: 'google' } : { placeId: undefined, verified: false }),
  };
  // Facts the planner attached to the OLD place (its rating, hours, the
  // why-this-stop blurb) belong to that place and go with it.
  // Its tags too ("French", "boutique hotel") — they describe the old place,
  // and they feed the rider's learned preferences. The MEAL is the slot's, not
  // the place's: a replaced dinner is still dinner, so that is kept.
  const meal = mealOf(old);
  for (const k of ['rating', 'userRatingCount', 'priceLevel', 'hours', 'reason', 'why', 'glance', 'preferenceTags', 'primaryType', 'types']) delete next[k];
  if (meal) next.meal = meal;
  if (place.rating != null) next.rating = place.rating;
  if (place.userRatingCount != null) next.userRatingCount = place.userRatingCount;
  if (place.priceLevel != null) next.priceLevel = place.priceLevel;

  return {
    ...concept,
    locations: locations.map((l, i) => (i === index ? next : l)),
    metrics: null,
    // The departure the original was measured from lives ON the metrics just
    // cleared, so it is carried here — otherwise the re-measure departs at the
    // evaluator's 08:00 default and every arrival moves for no real reason.
    departAt: concept.metrics?.depart ?? concept.departAt ?? null,
    // What changed, so the UI can be honest that the planner's prose was
    // written about the ORIGINAL stops.
    edits: [...(concept.edits ?? []), { index, from: old?.name ?? '', to: place.name, kind: old?.kind ?? null }],
  };
}

// ---- comparisons across options ----

/**
 * Recompute each option's "vs quickest" figures across the WHOLE set. The
 * evaluator only knows about the options it was handed — re-measure one and it
 * reports itself as the baseline at +0 — so the comparison has to be redone
 * here, against every option's current figures, exactly as the server does it.
 */
export function withDeltas(concepts) {
  const valid = (concepts ?? []).filter((c) => c?.metrics && Number.isFinite(c.metrics.rideMinutes));
  if (!valid.length) return concepts;
  const baseline = valid.reduce((best, c) => (c.metrics.rideMinutes < best.metrics.rideMinutes ? c : best));
  return concepts.map((c) => (c?.metrics && Number.isFinite(c.metrics.rideMinutes)
    ? {
      ...c,
      metrics: {
        ...c.metrics,
        deltaMiles: Math.round((c.metrics.miles - baseline.metrics.miles) * 10) / 10,
        deltaMinutes: Math.round(c.metrics.rideMinutes - baseline.metrics.rideMinutes),
      },
    }
    : c));
}

// ---- the road, for searching along it ----

/**
 * The concept's `searchPolyline` (encoded precision 5, as the server writes
 * it) as [{lat, lng}] — so the replace picker can search ALONG the proposed
 * road and say how far off it each candidate is, not just near the old pin.
 */
export function decodePolyline5(str) {
  if (!str || typeof str !== 'string') return [];
  const out = [];
  let lat = 0; let lng = 0; let i = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0; let result = 0; let byte;
      do {
        if (i >= str.length) return out; // a truncated string ends the line, it does not throw
        byte = str.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return out;
}

// ---- re-measure ----

/**
 * Measure one edited concept's road, with no model: the same evaluator the
 * planner calls, reached directly. Departs at the time the ORIGINAL
 * measurement used (recorded on its metrics) so the arrival moves only if the
 * road did.
 *
 * @returns the concept with fresh `metrics` and `searchPolyline`, AI prose kept
 */
export async function remeasureConcept(concept, basics, { fetchImpl = fetch, depart = concept?.departAt ?? null } = {}) {
  const res = await fetchImpl('/.netlify/functions/evaluate-route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      concepts: [{ id: concept.id, title: concept.title, locations: concept.locations }],
      range: basics?.range,
      pace: basics?.pace,
      routePrefs: basics?.routePrefs,
      ...(depart ? { depart } : {}),
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `could not re-measure (${res.status})`);
  const option = json.options?.[0];
  if (!option || option.error || !option.metrics) throw new Error(option?.error || 'the route could not be measured');
  return {
    ...concept,
    locations: option.locations ?? concept.locations,
    searchPolyline: option.searchPolyline ?? concept.searchPolyline,
    metrics: option.metrics,
  };
}

// ---- the proposal, as a trip, with no model ----

// Owner, Sep 20 2026 — the builder should let a rider "edit that and then move
// things around, or save for later". Every one of those tools already exists
// in the trip editor (drag to reorder, move a stop between days, add, remove,
// undo, saved Plans, and a library that backs up to the account). What stood
// between a chosen proposal and those tools was "Create this trip", which ran
// a SECOND full planner generation — 20 to 60 seconds of model time spent
// re-writing a plan the rider had already chosen.
//
// This builds the trip straight from the proposal instead. It returns the SAME
// shape the planner's generate tool returns ({ trip: { meta, days } }), so it
// goes through the very same normalisation — ids, endpoint kinds, gates, the
// date cascade — and the two doors can never produce differently-shaped trips.
//
// What it carries: every stop in order, split into days at each overnight,
// with its role, its verified identity, fuel flags, the overnights as the
// day's lodging, the dinners and lunches as meals, and the planner's own
// route description as the trip summary. What it honestly does NOT invent:
// per-day narrative summaries. Those are left empty (the day panel says "no
// description yet") and the planner can write them up on request.

// the app writes day.depart as a 12-hour clock
const twelveHour = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return '8:00 AM';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};

const near = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.015 && Math.abs(a.lng - b.lng) < 0.015;

// A food stop's meal: the planner's own word for it when it used one (its
// `meal`, else its tags, name or note — mealOf), else by its order in the day.
// A guess only in the second case, and an editable one.
function mealsFor(foodStops, overnight = null) {
  // the last food stop before the night's hotel, a short walk from it, is
  // that evening's dinner even when the planner did not say so
  const lastFood = foodStops[foodStops.length - 1];
  const said = (s) => mealOf(s) ?? (overnight && s === lastFood && isEvening(s, overnight) ? 'dinner' : null);
  const byOrder = foodStops.length === 1 ? ['lunch']
    : foodStops.length === 2 ? ['lunch', 'dinner']
      : ['breakfast', 'lunch', 'dinner'];
  const used = new Set();
  return foodStops.slice(0, 3).map((s, i) => {
    let meal = said(s) ?? byOrder[i] ?? 'lunch';
    if (used.has(meal)) meal = ['breakfast', 'lunch', 'dinner'].find((m) => !used.has(m)) ?? meal;
    used.add(meal);
    return {
      meal,
      name: s.name,
      where: s.detail ?? '',
      ...(Number.isFinite(s.lat) ? { lat: s.lat, lng: s.lng } : {}),
      ...(s.placeId ? { placeId: s.placeId, verified: 'google' } : {}),
    };
  });
}

// concept kinds → the trip's waypoint kinds (start / via / fuel / photo / end)
const waypointOf = (s) => ({
  name: s.name,
  lat: s.lat,
  lng: s.lng,
  kind: s.kind === 'fuel' ? 'fuel' : 'via', // endpoints are re-kinded by position below
  ...(s.kind === 'fuel' ? { fuel: true } : {}),
  note: s.detail ?? '',
  ...(Number.isFinite(s.dwell) ? { dwell: s.dwell } : {}),
  ...(s.placeId ? { placeId: s.placeId, verified: 'google' } : s.verified === false ? { verified: false } : {}),
});

/**
 * @param {object} concept   a proposal — { title, routeDescription, locations, metrics }
 * @param {object} basics    the builder's frame — { name, riders, pace, range, routePrefs }
 * @returns {{ trip: { meta, days } }} the planner's generate shape
 */
export function conceptToTrip(concept, basics = {}) {
  // The evaluator already settles the order; this repeats it (a no-op then)
  // for a proposal kept on the device from before it did.
  const stops = settleEvenings((concept?.locations ?? []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng)));
  if (stops.length < 2) throw new Error('the proposal has no route to build a trip from');

  // Split into days at each overnight. The overnight ENDS one day and STARTS
  // the next, which is what an overnight is.
  const segments = [];
  let cur = [stops[0]];
  for (let i = 1; i < stops.length; i++) {
    cur.push(stops[i]);
    const last = i === stops.length - 1;
    if (stops[i].kind === 'lodging' && !last) {
      segments.push(cur);
      cur = [stops[i]];
    }
  }
  segments.push(cur);

  const depart = twelveHour(concept?.metrics?.depart);
  const roundTrip = near(stops[0], stops[stops.length - 1]);

  const days = segments.map((seg, d) => {
    const first = seg[0];
    const last = seg[seg.length - 1];
    const overnight = last.kind === 'lodging' ? last : null;
    const waypoints = seg.map(waypointOf);
    waypoints[0].kind = 'start';
    if (waypoints.length > 1) waypoints[waypoints.length - 1].kind = 'end';
    return {
      title: `${first.name} → ${last.name}`,
      // An out-and-back rides its last day home; everything else is outbound.
      // The trip names its phases later if the rider wants a destination stay.
      phase: roundTrip && segments.length > 1 && d === segments.length - 1 ? 'return' : 'outbound',
      depart,
      summary: '', // not invented — the planner can write it up on request
      waypoints,
      meals: mealsFor(seg.slice(1, -1).filter((s) => s.kind === 'food'), overnight),
      lodging: overnight
        ? { status: 'reserve', name: overnight.name, where: overnight.detail ?? '', note: '', ...(overnight.placeId ? { placeId: overnight.placeId } : {}) }
        : { status: 'none', name: '', where: '', note: '' },
    };
  });

  return {
    trip: {
      meta: {
        title: String(basics.name || concept.title || 'New trip'),
        subtitle: concept.title ?? '',
        summary: concept.routeDescription ?? '',
        ...(Number.isFinite(basics.riders) ? { riders: basics.riders } : {}),
        ...(Number.isFinite(basics.pace) ? { pace: basics.pace } : {}),
        ...(basics.routePrefs ? { routePrefs: basics.routePrefs } : {}),
      },
      days,
    },
  };
}

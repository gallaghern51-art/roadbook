// Editing a proposed route by hand — no model in the loop.
//
// Owner, Sep 21 2026: "if you recommend one dinner spot and they dont want to
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
export function replaceConceptStop(concept, index, place) {
  const locations = concept?.locations ?? [];
  if (!Number.isInteger(index) || index <= 0 || index >= locations.length - 1) {
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
  for (const k of ['rating', 'userRatingCount', 'priceLevel', 'hours', 'reason', 'why', 'glance']) delete next[k];
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

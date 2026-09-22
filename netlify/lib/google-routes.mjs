// Google Routes API (computeRoutes v2), server side — the one place the
// request is built. The google-route function (Ride Mode's traffic anchor,
// the planning screen's departure-time quote, the route sheet's toll price)
// and the MCP server (route options a rider's own AI shows them) both call
// this, so a field-mask or modifier fix lands in every quote at once.
//
// The key never leaves the server. Callers treat any throw as "no traffic
// answer" and keep Valhalla's free-flowing figure.

const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK = [
  'routes.duration',
  'routes.distanceMeters',
  'routes.polyline',
  'routes.legs.duration',
  'routes.legs.distanceMeters',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.startLocation',
  // What a toll road actually costs. Valhalla knows a route HAS a toll
  // (summary.has_toll) but never what it charges; Google prices it. Asked for
  // only when the caller wants it, because TOLLS is an extra computation.
  'routes.travelAdvisory.tollInfo',
].join(',');

const latLng = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
// A stop with place identity routes to the PLACE — Google snaps it to the
// right driveway. A raw coordinate gets stopover semantics (vehicleStopover +
// sideOfRoad) so the router aims for pavement a vehicle can actually stop on,
// instead of exiting a highway to touch a pin in a parking lot and re-enter.
const stopWaypoint = (p) => (typeof p.placeId === 'string' && p.placeId
  ? { placeId: p.placeId, vehicleStopover: true }
  : { ...latLng(p), vehicleStopover: true, sideOfRoad: true });
// A pass-through point: the road must go THROUGH it but nobody stops there.
// This is how a traffic quote is pinned to Valhalla's road rather than to
// whatever road Google would pick between the same two ends.
const viaWaypoint = (p) => ({ ...latLng(p), via: true });
const seconds = (s) => (typeof s === 'string' ? parseFloat(s) : (s ?? 0)); // "1234s" → 1234

export const okPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

/**
 * @param {string} key  GOOGLE_MAPS_API_KEY
 * @param {object} o
 * @param {{lat,lng,heading?}} o.origin
 * @param {{lat,lng,placeId?,via?}[]} o.waypoints  ≥ 1; the last is the destination,
 *   the rest ride along as intermediates (`via: true` = pass through, no stop)
 * @param {boolean} [o.avoidTolls]
 * @param {boolean} [o.tolls]           ask for the toll price (extra computation)
 * @param {string} [o.departureTime]    ISO, in the FUTURE → predicted traffic for then
 * @returns {Promise<{geometry, distanceMeters, durationSeconds, toll?, legs}>}
 */
export async function computeRoute(key, { origin, waypoints, avoidTolls = false, tolls = false, departureTime = null }, fetchImpl = fetch) {
  if (!key) { const e = new Error('GOOGLE_MAPS_API_KEY not configured'); e.status = 501; throw e; }
  if (!okPoint(origin) || !Array.isArray(waypoints) || !waypoints.length || !waypoints.every(okPoint)) {
    const e = new Error('need origin {lat,lng} and waypoints [{lat,lng},…]'); e.status = 400; throw e;
  }
  // Routes API hard limit is 25 intermediates — a day never gets close, but a
  // malformed client must not turn into a 400 storm against Google.
  const vias = waypoints.slice(0, -1).slice(0, 23);
  const dest = waypoints[waypoints.length - 1];

  // The bike's heading (when moving) rides into the origin so the route
  // departs the way the bike is pointed — without it Google assumes a
  // direction from the road snap and can open with a turn-around tour.
  const gOrigin = latLng(origin);
  if (Number.isFinite(origin.heading)) gOrigin.location.heading = ((Math.round(origin.heading) % 360) + 360) % 360;

  const gBody = {
    origin: gOrigin, // where the bike IS — plain position, no stop semantics
    destination: stopWaypoint(dest),
    ...(vias.length ? { intermediates: vias.map((p) => (p.via ? viaWaypoint(p) : stopWaypoint(p))) } : {}),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE', // live traffic — bills as the Pro SKU
    polylineEncoding: 'GEO_JSON_LINESTRING',
    units: 'IMPERIAL',
    // The rider's own toll rule has to ride into this request, or the price
    // quoted back describes a road they asked not to be sent down.
    ...(avoidTolls ? { routeModifiers: { avoidTolls: true } } : {}),
    ...(tolls ? { extraComputations: ['TOLLS'] } : {}),
    // PLANNING asks about a departure that has not happened yet. With a future
    // departureTime the Routes API answers with PREDICTED traffic for that
    // moment rather than with traffic right now — which is the whole point on
    // a planning screen: a Sunday evening run off Long Island is not a Tuesday
    // morning one. Google rejects a departureTime in the past, so the caller
    // only sends future ones.
    ...(departureTime ? { departureTime } : {}),
  };

  let gRes;
  try {
    gRes = await fetchImpl(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(gBody),
    });
  } catch (e) {
    const err = new Error(`google unreachable: ${e.message}`); err.status = 502; throw err;
  }
  if (!gRes.ok) {
    const detail = await gRes.text().catch(() => '');
    const err = new Error(`google ${gRes.status}`); err.status = 502; err.detail = detail.slice(0, 300); throw err;
  }
  const json = await gRes.json();
  const route = json.routes?.[0];
  if (!route) { const err = new Error('no route'); err.status = 502; throw err; }

  // Google returns a price per toll pass/currency; the first entry is the
  // cash estimate for this corridor. It is an ESTIMATE against GOOGLE's road
  // between these points, not a receipt for the Valhalla line we draw — the
  // UI says so rather than quoting it as a fact.
  const price = route.travelAdvisory?.tollInfo?.estimatedPrice?.[0];
  const toll = price
    ? {
      currency: price.currencyCode ?? 'USD',
      amount: Number(price.units ?? 0) + (Number(price.nanos ?? 0) / 1e9),
    }
    : null;

  return {
    geometry: route.polyline?.geoJsonLinestring?.coordinates ?? [],
    distanceMeters: route.distanceMeters ?? 0,
    durationSeconds: seconds(route.duration),
    ...(toll ? { toll } : {}),
    legs: (route.legs ?? []).map((leg) => ({
      distanceMeters: leg.distanceMeters ?? 0,
      durationSeconds: seconds(leg.duration),
      steps: (leg.steps ?? []).map((st) => ({
        lat: st.startLocation?.latLng?.latitude,
        lng: st.startLocation?.latLng?.longitude,
        distanceMeters: st.distanceMeters ?? 0,
        staticDurationSeconds: seconds(st.staticDuration),
        maneuver: st.navigationInstruction?.maneuver ?? null,
        instruction: (st.navigationInstruction?.instructions ?? '').split('\n')[0],
      })),
    })),
  };
}

// Google rejects a departure in the past; a minute of slack absorbs the clock
// ticking between the caller reading it and the request landing.
export const isFutureIso = (iso) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > Date.now() + 60_000;
};

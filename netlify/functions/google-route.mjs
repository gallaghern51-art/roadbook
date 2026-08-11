// Traffic-aware routing proxy — Google Routes API (computeRoutes v2).
// The API key lives in the Netlify env (GOOGLE_MAPS_API_KEY), never in the
// client bundle. The client treats any non-200 as "use OSRM instead", so this
// function degrades safely when the key is missing or Google is down.
//
// POST { origin: {lat,lng}, waypoints: [{lat,lng}, ...] }  (waypoints ≥ 1;
// last one is the destination, the rest ride along as intermediates)
// → { geometry: [[lng,lat],...], distanceMeters, durationSeconds,
//     legs: [{ distanceMeters, durationSeconds,
//              steps: [{ lat, lng, distanceMeters, staticDurationSeconds,
//                        maneuver, instruction }] }] }

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
].join(',');

const latLng = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
// A stop with place identity routes to the PLACE — Google snaps it to the
// right driveway. A raw coordinate gets stopover semantics (vehicleStopover +
// sideOfRoad) so the router aims for pavement a vehicle can actually stop on,
// instead of exiting a highway to touch a pin in a parking lot and re-enter.
const stopWaypoint = (p) => (typeof p.placeId === 'string' && p.placeId
  ? { placeId: p.placeId, vehicleStopover: true }
  : { ...latLng(p), vehicleStopover: true, sideOfRoad: true });
const seconds = (s) => (typeof s === 'string' ? parseFloat(s) : (s ?? 0)); // "1234s" → 1234

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return Response.json({ error: 'GOOGLE_MAPS_API_KEY not configured' }, { status: 501 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad JSON' }, { status: 400 });
  }
  const { origin, waypoints } = body ?? {};
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  if (!ok(origin) || !Array.isArray(waypoints) || !waypoints.length || !waypoints.every(ok)) {
    return Response.json({ error: 'need origin {lat,lng} and waypoints [{lat,lng},…]' }, { status: 400 });
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
    ...(vias.length ? { intermediates: vias.map(stopWaypoint) } : {}),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE', // live traffic — bills as the Pro SKU
    polylineEncoding: 'GEO_JSON_LINESTRING',
    units: 'IMPERIAL',
  };

  let gRes;
  try {
    gRes = await fetch(ROUTES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(gBody),
    });
  } catch (e) {
    return Response.json({ error: `google unreachable: ${e.message}` }, { status: 502 });
  }
  if (!gRes.ok) {
    const detail = await gRes.text().catch(() => '');
    return Response.json({ error: `google ${gRes.status}`, detail: detail.slice(0, 300) }, { status: 502 });
  }
  const json = await gRes.json();
  const route = json.routes?.[0];
  if (!route) return Response.json({ error: 'no route' }, { status: 502 });

  return Response.json({
    geometry: route.polyline?.geoJsonLinestring?.coordinates ?? [],
    distanceMeters: route.distanceMeters ?? 0,
    durationSeconds: seconds(route.duration),
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
  }, { headers: { 'Cache-Control': 'no-store' } });
};

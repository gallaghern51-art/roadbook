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
//
// The request itself is built in ../lib/google-routes.mjs, which the MCP
// server shares — one field mask, one set of modifiers, for every quote.

import { computeRoute } from '../lib/google-routes.mjs';

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
  const { origin, waypoints, avoidTolls = false, tolls = false, departureTime = null } = body ?? {};
  try {
    const out = await computeRoute(key, { origin, waypoints, avoidTolls, tolls, departureTime });
    return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const status = e.status === 400 ? 400 : e.status === 501 ? 501 : 502;
    return Response.json({ error: e.message, ...(e.detail ? { detail: e.detail } : {}) }, { status });
  }
};

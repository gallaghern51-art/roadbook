// Nearby / along-route place browse for the rider — the picker's server half.
//
// POST {
//   category: 'fuel'|'food'|'coffee'|'lodging'|'sights'|'moto'|'help'|null,
//   query?:   free text (optional when a category is given),
//   near:     { lat, lng },          // bias centre — the bike, a stop, a map point
//   radiusMi?: number,               // default 25
//   route?:   [[lng,lat], ...],      // when present: Search Along Route, and
//                                    // each hit carries Google's routing summary
//   limit?:   number                 // ≤ 10
// }
// → [{ id, name, detail, lat, lng, rating, userRatingCount, priceLevel, hours,
//      periods, openNow, primaryType, status, googleMapsUri, phone,
//      routeDistanceMeters?, routeDurationSeconds? }]
//
// Cost note: hours + rating + price is the Places Enterprise tier, the same
// tier verify-places already pays per AI-authored stop. This fires on a chip
// tap or a search, never per keystroke (the client debounces), so a browse is
// cents. Along-route adds Google's routing summaries — that is the "+4 min"
// figure a rider decides on, and it is worth the extra.

import { searchPlacesGoogle } from '../lib/places-core.mjs';

// Category → Google Places (New) type. Strict filtering, so a town-centre pin
// or a convenience store can never come back as a fuel stop.
const TYPES = {
  fuel: { type: 'gas_station', query: 'gas station' },
  food: { type: 'restaurant', query: 'restaurant' },
  coffee: { type: 'cafe', query: 'coffee' },
  lodging: { type: 'lodging', query: 'motel hotel lodging' },
  sights: { type: 'tourist_attraction', query: 'scenic viewpoint attraction' },
  moto: { type: 'motorcycle_repair_shop', query: 'motorcycle repair dealer' },
  help: { type: 'hospital', query: 'hospital urgent care' },
};

// Precision-5 encoder (Google's format; Valhalla's is precision 6).
function encodePolyline5(coords) {
  let out = '', plat = 0, plng = 0;
  const enc = (v) => {
    let s = '';
    v = v < 0 ? ~(v << 1) : (v << 1);
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of coords) {
    const ilat = Math.round(lat * 1e5), ilng = Math.round(lng * 1e5);
    out += enc(ilat - plat) + enc(ilng - plng);
    plat = ilat; plng = ilng;
  }
  return out;
}

// Search Along Route is bounded in how much geometry it accepts; a 300-mile
// day at 5-decimal density is far past it. Thin to at most this many vertices.
const MAX_ROUTE_PTS = 400;
function thin(coords) {
  if (!Array.isArray(coords) || coords.length <= MAX_ROUTE_PTS) return coords;
  const step = coords.length / MAX_ROUTE_PTS;
  const out = [];
  for (let i = 0; i < MAX_ROUTE_PTS; i++) out.push(coords[Math.floor(i * step)]);
  out.push(coords[coords.length - 1]);
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return Response.json({ error: 'GOOGLE_MAPS_API_KEY not configured' }, { status: 501 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'bad JSON' }, { status: 400 }); }

  const cat = body?.category ? TYPES[body.category] : null;
  const text = String(body?.query ?? '').trim();
  if (!cat && text.length < 2) return Response.json([]);
  const near = body?.near;
  if (!near || !Number.isFinite(near.lat) || !Number.isFinite(near.lng)) {
    return Response.json({ error: 'need near {lat,lng}' }, { status: 400 });
  }
  const limit = Math.min(10, Math.max(1, Number(body?.limit) || 8));
  const radiusM = Math.min(50000, Math.max(1000, (Number(body?.radiusMi) || 25) * 1609.34));
  const route = Array.isArray(body?.route) && body.route.length > 1 ? thin(body.route) : null;

  try {
    const places = await searchPlacesGoogle(key, text || cat.query, near, {
      limit,
      hours: true,
      enrich: true,
      type: cat?.type ?? null,
      radiusM,
      encodedPolyline: route ? encodePolyline5(route) : null,
    });
    // permanently closed places are not options
    const open = places.filter((p) => p.status !== 'CLOSED_PERMANENTLY');
    return Response.json(open, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: String(e.message).slice(0, 300) }, { status: 502 });
  }
};

// What is at a coordinate the rider pressed on — the name a dropped pin
// wears (owner, Sep 13 2026: "reverse-geocode it (Google Places nearby /
// the nearest road name is fine)"). The key stays here.
//
// GET ?lat=&lng=
// → { name, detail, road, locality, source: 'geocode' | 'nearby' | null }
//
// Two sources, in order:
//   1. Google Geocoding (reverse): the ROAD the pin sits on and the town —
//      a pin on a pass is "US-14A, Lovell" and that is exactly what the rider
//      meant. Pinned to street/route/locality results, so a pin in open
//      country never comes back as a plus code.
//   2. Places Nearby Search (New), ranked by distance, one result within
//      300 m: when there is no road (a shoreline, a trailhead) the nearest
//      listed thing is still a better name than a coordinate. Its name is
//      "Near X" — the pin is NOT that place, and nothing here is verified.
// Neither source names a business the pin is claimed to be: the pin stays
// `placed: 'rider'`; this only labels it. A key that has no Geocoding API
// enabled falls straight through to Nearby; no key → 501 and the client
// labels the pin by its coordinate.
//
// Cost: one Geocoding call (and at most one Nearby, Pro SKU) per drop —
// never per touch move. Cached a day per rounded coordinate.

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';

const comp = (r, type) => r.address_components?.find((c) => c.types?.includes(type))?.long_name ?? '';

/** The label for one Geocoding result set — exported for the sim. */
export function labelFromGeocode(json) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const pick = ['street_address', 'route', 'intersection', 'premise', 'locality', 'neighborhood'];
  const r = results.find((x) => x.types?.some((t) => pick.includes(t))) ?? results.find((x) => !x.types?.includes('plus_code'));
  if (!r) return null;
  const road = comp(r, 'route');
  const locality = comp(r, 'locality') || comp(r, 'postal_town') || comp(r, 'administrative_area_level_3') || comp(r, 'administrative_area_level_2');
  const name = road ? (locality ? `${road}, ${locality}` : road) : (locality || String(r.formatted_address ?? '').split(',')[0]);
  if (!name) return null;
  return { name, detail: r.formatted_address ?? '', road, locality, source: 'geocode' };
}

/** The label from a Nearby result set — exported for the sim. */
export function labelFromNearby(json, { near = 'Near' } = {}) {
  const p = (json?.places ?? [])[0];
  const pn = p?.displayName?.text;
  if (!pn) return null;
  return { name: `${near} ${pn}`, detail: p.formattedAddress ?? '', road: '', locality: '', source: 'nearby' };
}

async function geocode(key, lat, lng) {
  const url = `${GEOCODE_URL}?latlng=${lat},${lng}&result_type=street_address|route|intersection|locality|premise|neighborhood&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.status && !['OK', 'ZERO_RESULTS'].includes(json.status)) return null; // REQUEST_DENIED: the API is not enabled on this key
  return labelFromGeocode(json);
}

async function nearby(key, lat, lng, near) {
  const res = await fetch(NEARBY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.displayName,places.formattedAddress' },
    body: JSON.stringify({ maxResultCount: 1, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 300 } } }),
  });
  if (!res.ok) return null;
  return labelFromNearby(await res.json(), { near });
}

export default async (req) => {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return Response.json({ error: 'GOOGLE_MAPS_API_KEY not configured' }, { status: 501 });
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get('lat'));
  const lng = Number(url.searchParams.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return Response.json({ error: 'need lat & lng' }, { status: 400 });
  }
  const near = url.searchParams.get('near') || 'Near'; // the client's word, localised
  const la = lat.toFixed(5), ln = lng.toFixed(5);
  try {
    const label = (await geocode(key, la, ln).catch(() => null)) ?? (await nearby(key, lat, lng, near).catch(() => null));
    return Response.json(label ?? { name: null, detail: '', road: '', locality: '', source: null }, { headers: { 'Cache-Control': 'private, max-age=86400' } });
  } catch (e) {
    return Response.json({ error: String(e.message).slice(0, 200) }, { status: 502 });
  }
};

// One place, in full — Google Places (New) Place Details, key server-side.
// GET ?id=<placeId> → the same row shape nearby-places returns, plus
// `summary` (Google's editorial line), `photos` (names for place-photo.mjs,
// with author attributions) and the weekly hours. This is what the place
// sheet opens on; a list row never pays for it.
//
// Places terms: place data may be cached up to 30 days; the id indefinitely.
// The response is marked private + 10 min so a sheet reopened in the same
// session is free and nothing sticks around longer than it should.

const FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location', 'types', 'primaryType', 'businessStatus',
  'rating', 'userRatingCount', 'priceLevel', 'googleMapsUri', 'websiteUri', 'nationalPhoneNumber',
  'regularOpeningHours.weekdayDescriptions', 'regularOpeningHours.periods', 'currentOpeningHours.openNow',
  'editorialSummary', 'photos',
];

export function normalizePlace(p) {
  return {
    id: p.id,
    name: p.displayName?.text ?? '',
    detail: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    types: p.types ?? [],
    primaryType: p.primaryType ?? '',
    status: p.businessStatus ?? '',
    hours: p.regularOpeningHours?.weekdayDescriptions ?? null,
    periods: p.regularOpeningHours?.periods ?? null,
    openNow: typeof p.currentOpeningHours?.openNow === 'boolean' ? p.currentOpeningHours.openNow : null,
    rating: Number.isFinite(p.rating) ? p.rating : null,
    userRatingCount: Number.isFinite(p.userRatingCount) ? p.userRatingCount : null,
    priceLevel: p.priceLevel ?? null,
    googleMapsUri: p.googleMapsUri ?? null,
    websiteUri: p.websiteUri ?? null,
    phone: p.nationalPhoneNumber ?? null,
    summary: p.editorialSummary?.text ?? null,
    photos: (p.photos ?? []).slice(0, 3).map((ph) => ({
      name: ph.name,
      w: ph.widthPx ?? null,
      h: ph.heightPx ?? null,
      by: (ph.authorAttributions ?? []).map((a) => ({ name: a.displayName ?? '', uri: a.uri ?? null })),
    })),
  };
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('GET only', { status: 405 });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return Response.json({ error: 'GOOGLE_MAPS_API_KEY not configured' }, { status: 501 });
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!/^[A-Za-z0-9_-]{5,}$/.test(id)) return Response.json({ error: 'need a place id' }, { status: 400 });
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELDS.join(',') },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return Response.json({ error: `places ${res.status}: ${detail.slice(0, 200)}` }, { status: res.status === 404 ? 404 : 502 });
    }
    return Response.json(normalizePlace(await res.json()), { headers: { 'Cache-Control': 'private, max-age=600' } });
  } catch (e) {
    return Response.json({ error: String(e.message).slice(0, 300) }, { status: 502 });
  }
};

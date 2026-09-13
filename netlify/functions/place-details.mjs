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
  // what Google's own page shows and ours did not (owner, Sep 13 2026: "how
  // can google be so rich but ours are so scarce?"): reviews with their
  // authors, the generative overview, and the practical facts a rider asks
  'reviews', 'generativeSummary', 'accessibilityOptions', 'parkingOptions', 'paymentOptions',
  'restroom', 'goodForGroups', 'allowsDogs', 'outdoorSeating', 'reservable',
  'dineIn', 'takeout', 'delivery', 'servesBreakfast', 'servesLunch', 'servesDinner', 'servesCoffee',
  'liveMusic', 'goodForChildren', 'goodForWatchingSports',
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
    summary: p.editorialSummary?.text ?? p.generativeSummary?.overview?.text ?? null,
    overview: p.generativeSummary?.overview?.text ?? null,
    reviews: (p.reviews ?? []).slice(0, 5).map((r) => ({
      rating: Number.isFinite(r.rating) ? r.rating : null,
      when: r.relativePublishTimeDescription ?? '',
      text: r.text?.text ?? r.originalText?.text ?? '',
      by: r.authorAttribution?.displayName ?? '',
      uri: r.authorAttribution?.uri ?? null,
    })).filter((r) => r.text),
    // the practical facts, only the ones Google actually states
    amenities: [
      ['Dine-in', p.dineIn], ['Takeout', p.takeout], ['Delivery', p.delivery], ['Reservations', p.reservable],
      ['Breakfast', p.servesBreakfast], ['Lunch', p.servesLunch], ['Dinner', p.servesDinner], ['Coffee', p.servesCoffee],
      ['Outdoor seating', p.outdoorSeating], ['Live music', p.liveMusic], ['Good for groups', p.goodForGroups],
      ['Dogs OK', p.allowsDogs], ['Restroom', p.restroom], ['Kids', p.goodForChildren],
      ['Wheelchair entrance', p.accessibilityOptions?.wheelchairAccessibleEntrance],
      ['Wheelchair parking', p.accessibilityOptions?.wheelchairAccessibleParking],
      ['Wheelchair restroom', p.accessibilityOptions?.wheelchairAccessibleRestroom],
      ['Free parking', p.parkingOptions?.freeParkingLot || p.parkingOptions?.freeStreetParking],
      ['Paid parking', p.parkingOptions?.paidParkingLot || p.parkingOptions?.paidStreetParking],
      ['Cards', p.paymentOptions?.acceptsCreditCards], ['Cash only', p.paymentOptions?.acceptsCashOnly], ['NFC pay', p.paymentOptions?.acceptsNfc],
    ].filter(([, v]) => typeof v === 'boolean').map(([label, ok]) => ({ label, ok })),
    photos: (p.photos ?? []).slice(0, 5).map((ph) => ({
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

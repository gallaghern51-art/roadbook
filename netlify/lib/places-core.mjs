// Google Places (New) Text Search — shared by the google-places function
// (client search box), planner-core (the AI's search_places tool), and
// verify-places (the server-side check on AI-authored stops).
// One call returns names + addresses + coordinates; Pro SKU, 5k free/month.
// The `hours` option adds weekly opening hours to each result — that bumps
// the call to the Enterprise SKU, so it is passed ONLY by the planner's
// search_places tool (a handful of calls per chat), never the client search
// box (fires on every debounced keystroke).
//
// `type` + `classify` are what let a caller ask "is this actually a GAS
// STATION" rather than "is there anything by this name here". Both ride in the
// Pro tier the base call already pays for, so asking costs nothing extra:
//   type      → includedType + strictTypeFiltering, so a town-center pin or a
//               convenience store cannot come back as a fuel stop.
//   classify  → returns each result's types and businessStatus, so a
//               permanently-closed diner can be rejected before it reaches a
//               rider's plan.

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

export async function searchPlacesGoogle(key, query, near, {
  limit = 6,
  hours = false,
  enrich = false,
  type = null,
  classify = false,
  radiusM = 50000,
} = {}) {
  const body = {
    textQuery: query,
    pageSize: Math.min(10, limit),
    ...(type ? { includedType: type, strictTypeFiltering: true } : {}),
    ...(near && Number.isFinite(near.lat) && Number.isFinite(near.lng)
      ? { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: radiusM } } }
      : {}),
  };
  const fields = new Set(['places.id', 'places.displayName', 'places.formattedAddress', 'places.location']);
  if (classify || enrich) {
    fields.add('places.types');
    fields.add('places.primaryType');
    fields.add('places.businessStatus');
  }
  if (hours) fields.add('places.regularOpeningHours.weekdayDescriptions');
  if (enrich) {
    fields.add('places.rating');
    fields.add('places.userRatingCount');
    fields.add('places.priceLevel');
    fields.add('places.googleMapsUri');
    fields.add('places.websiteUri');
    fields.add('places.nationalPhoneNumber');
  }
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': [...fields].join(','),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`places ${res.status}: ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return (json.places ?? []).map((p) => ({
    id: p.id,
    name: p.displayName?.text ?? '',
    detail: p.formattedAddress ?? '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    ...((classify || enrich) ? { types: p.types ?? [], primaryType: p.primaryType ?? '', status: p.businessStatus ?? '' } : {}),
    ...(hours ? { hours: p.regularOpeningHours?.weekdayDescriptions ?? null } : {}),
    ...(enrich ? {
      rating: Number.isFinite(p.rating) ? p.rating : null,
      userRatingCount: Number.isFinite(p.userRatingCount) ? p.userRatingCount : null,
      priceLevel: p.priceLevel ?? null,
      googleMapsUri: p.googleMapsUri ?? null,
      websiteUri: p.websiteUri ?? null,
      phone: p.nationalPhoneNumber ?? null,
    } : {}),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

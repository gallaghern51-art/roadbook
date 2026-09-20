// Places this rider has actually chosen, most recent first.
//
// The home search kept its own five-deep list inline; the add-a-stop picker
// had none at all, so the surface where a rider most often re-uses a place —
// the fuel stop they always take, the diner they always stop at — offered
// nothing but a blank field. Google's "Add stops to your route" leads with
// recents for exactly that reason.
//
// The key is the one the home search already wrote, so a rider's existing
// history carries over rather than starting again.

const KEY = 'moto.homeRecent.v1';
const MAX = 12;

/** @returns {{name,lat,lng,detail?,placeId?,at?}[]} */
export function recentPlaces(limit = MAX) {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list.slice(0, limit) : [];
  } catch { return []; }
}

/**
 * Record a chosen place. Deduped by place id where there is one and by name
 * otherwise — the same diner reached from the map and from a search is one
 * entry, and a place with no listing still behaves.
 */
export function pushRecentPlace(place) {
  if (!place?.name || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return;
  const row = {
    name: place.name,
    lat: place.lat,
    lng: place.lng,
    detail: place.detail ?? '',
    ...(place.placeId ?? (place.source === 'google' ? place.id : null)
      ? { placeId: place.placeId ?? place.id }
      : {}),
    at: Date.now(),
  };
  const same = (a, b) => (a.placeId && b.placeId ? a.placeId === b.placeId : a.name === b.name);
  try {
    localStorage.setItem(KEY, JSON.stringify([row, ...recentPlaces(MAX).filter((r) => !same(r, row))].slice(0, MAX)));
  } catch { /* storage full — a convenience, never a failure */ }
}

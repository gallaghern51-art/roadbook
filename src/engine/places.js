// A place in full, for the place sheet — Google Place Details through
// netlify/functions/place-details (the key stays there), or Mapbox Places
// Details straight from the browser for a Mapbox id. Cached per page load by
// id, so reopening a sheet costs nothing; a failed lookup is not cached, so
// the next open tries again.
import { placesProvider, isMapboxId } from './placesProvider.js';
import { mapboxDetails, mapboxReverse, hasMapboxToken } from './mapboxPlaces.js';

const FN = '/.netlify/functions/place-details';
const PHOTO_FN = '/.netlify/functions/place-photo';
const cache = new Map();

export async function placeDetails(placeId) {
  if (!placeId) return null;
  // A Mapbox id's facts come from Mapbox whichever database the app is set to.
  // In the Mapbox preview a Google id is never sent to Google: the sheet shows
  // what the stop already carries.
  const mapbox = isMapboxId(placeId);
  if (!mapbox && placesProvider() === 'mapbox') return null;
  if (cache.has(placeId)) return cache.get(placeId);
  // A 501 here (no key) is just "no details" — it does NOT switch the session
  // to Mapbox; only a search answering 501 does that (nearby.js, geocode.js),
  // because a search is what leaves the rider with nothing on screen.
  const p = mapbox
    ? mapboxDetails(placeId).catch(() => null)
    : fetch(`${FN}?id=${encodeURIComponent(placeId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  cache.set(placeId, p);
  const v = await p;
  if (!v) cache.delete(placeId);
  return v;
}

/** The URL of a place photo at about `w` px wide (a 302 to Google's CDN). */
export const photoUrl = (name, w = 900) => `${PHOTO_FN}?name=${encodeURIComponent(name)}&w=${w}`;

/** Index into Google's weekdayDescriptions (Monday first) for today. */
export const todayIndex = (d = new Date()) => (d.getDay() + 6) % 7;

/** "Monday: 7:00 AM – 9:00 PM" → "7:00 AM – 9:00 PM". */
export const hoursOnly = (line) => String(line ?? '').replace(/^[^:]+:\s*/, '');

// ---- a dropped pin's name ----
// The rider pressed a spot with no listing under it; what is there is a
// road and a town (netlify/functions/reverse-geocode — the key stays
// there — or Mapbox Geocoding v6 in the Mapbox preview). One call per drop,
// cached per page load by rounded coordinate; no key or no answer → the
// coordinate itself is the label, and the pin is `placed: 'rider'` either
// way — this never verifies anything.
const RG_FN = '/.netlify/functions/reverse-geocode';
const rgCache = new Map();

/** "44.0612, -107.9520" — the label a pin wears until (or unless) a name arrives. */
export const coordLabel = ({ lat, lng }, dp = 4) => `${Number(lat).toFixed(dp)}, ${Number(lng).toFixed(dp)}`;

/** { name, detail, road, locality, source } or null. `near` is the localised "Near" for a nearby-place label. */
export async function reverseGeocode({ lat, lng }, { near = 'Near' } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const provider = placesProvider();
  const k = `${provider}|${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (rgCache.has(k)) return rgCache.get(k);
  const viaMapbox = () => mapboxReverse({ lat, lng }).catch(() => null);
  const p = provider === 'mapbox'
    ? viaMapbox()
    : fetch(`${RG_FN}?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&near=${encodeURIComponent(near)}`)
      .then((r) => {
        // no Google key on this server: name THIS pin with Mapbox rather than
        // leave a coordinate (the session's database is a search's decision)
        if (r.status === 501) return hasMapboxToken() ? viaMapbox() : null;
        return r.ok ? r.json().then((j) => (j && j.name ? j : null)) : null;
      })
      .catch(() => null);
  rgCache.set(k, p);
  const v = await p;
  if (!v) rgCache.delete(k);
  return v;
}

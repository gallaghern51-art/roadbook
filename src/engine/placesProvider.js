// Which places database the app asks. On this branch MAPBOX is the default —
// Search Box, Places Details, Geocoding v6 and Directions, the preview of
// docs/mapbox-places-plan.md — and Google Places is what you opt back into to
// compare. Google's terms forbid Places content on a non-Google map (Service
// Specific Terms §14.2, Terms of Service §3.2.3(e)); Mapbox data on the Mapbox
// map raises no such question.
//
// Device-scoped like every setting: `placeData` in moto.settings.v1, flipped in
// Settings → Map → Place data, or with `?places=mapbox` / `?places=google` on
// any URL (the choice is remembered). The key is `placeData`, not the `places`
// of the first cut: that cut defaulted to Google and the settings provider
// wrote the default into every browser that opened it, so a stored 'google'
// under the old key is not a choice anyone made (owner, Sep 14 2026: "we are
// supposed to be testing mapbox places on this not google").
// Read on every call — one localStorage read — so a flip takes effect on the
// next search without a reload.

import { hasMapboxToken } from './mapboxPlaces.js';

const KEY = 'moto.settings.v1';

function readSettings() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

// A `?places=` on the URL is written into the settings before the settings
// provider first reads them, so the Settings control shows the same choice.
try {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('places') : null;
  if (q === 'mapbox' || q === 'google') localStorage.setItem(KEY, JSON.stringify({ ...readSettings(), placeData: q }));
} catch { /* no storage: node, private mode */ }

// Google chosen on a server with no GOOGLE_MAPS_API_KEY (`npm run dev` without
// the key in .env.local, a keyless deploy) answers 501 from every Google-backed
// function. Google was never an option there, so rather than show places with
// nothing on them the session falls over to Mapbox the first time a 501 comes
// back. The setting itself is left alone.
let googleUnconfigured = false;
export function markGoogleUnconfigured() { googleUnconfigured = true; }

/** 'mapbox' | 'google' — Mapbox unless Google is chosen and actually configured (or there is no Mapbox token). */
export function placesProvider() {
  if (!hasMapboxToken()) return 'google';
  if (readSettings().placeData !== 'google') return 'mapbox';
  return googleUnconfigured ? 'mapbox' : 'google';
}

/** A Mapbox id is base64 of "urn:mbx…"; a Google place id never starts that way. */
export const isMapboxId = (id) => typeof id === 'string' && id.startsWith('dXJuOm1ieH');

/** A row that came from a live places database (not Nominatim, not a dropped pin). */
export const isListed = (r) => (r?.source === 'google' || r?.source === 'mapbox') && !!r?.id;

/**
 * The identity and verification stamp a picked row carries onto a stop:
 * `{ placeId, verified: 'google' | 'mapbox' }`, or nothing for an unlisted row.
 * The stamp names the database that answered, so a Mapbox-verified stop is
 * never mistaken for a Google listing (and never sent to Google by id).
 */
export function placeStamp(r) {
  return isListed(r) ? { placeId: r.id, verified: r.source } : {};
}

/** A `verified` value that means "a live database named this place". */
export const isVerifiedStamp = (v) => v === 'google' || v === 'mapbox' || v === 'model';

/** Which database a place id's facts come from — for the attribution line. */
export const factsSource = (id) => (isMapboxId(id) ? 'Mapbox' : 'Google');

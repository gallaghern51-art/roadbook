// The place sims mock Google's functions (nearby-places, place-details,
// reverse-geocode, google-places). Since Sep 14, 2026 the app defaults to
// Mapbox places (src/engine/placesProvider.js), so a sim that mocks Google has
// to ASK for Google — written before the app's first read of its settings.
// Merged, never replaced: a sim's own settings stand beside it.
export async function pinGooglePlaces(page) {
  await page.addInitScript(() => {
    try {
      const key = 'moto.settings.v1';
      const s = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...s, placeData: 'google' }));
    } catch { /* storage refused */ }
  });
}

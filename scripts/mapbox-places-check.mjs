// The Mapbox places preview (docs/mapbox-places-plan.md): the pure adapter in
// src/engine/mapboxPlaces.js against fixtures shaped like the live answers of
// Sep 14, 2026, then — when a token is in the environment — the live APIs.
//
//   node scripts/mapbox-places-check.mjs
//   set -a; . ./.env.local; set +a; node scripts/mapbox-places-check.mjs   # + live
//
// The public token is URL-restricted, so the live half sends the dev origin as
// its Referer, the way the browser on :5199 does.

import {
  toGooglePeriods, weekdayText, rowFromFeature, detailsFromFeature, labelFromReverse,
  corridorSamples, bboxAround, mapboxSearch, mapboxDetails, mapboxReverse, mapboxTrafficEta, _setMapboxToken,
} from '../src/engine/mapboxPlaces.js';
import { placeStamp, isMapboxId, isVerifiedStamp, factsSource } from '../src/engine/placesProvider.js';
import { openAt, cuisineLabel, searchNearby } from '../src/engine/nearby.js';
import { buildQuickTrip } from '../src/engine/quickRide.js';
import { haversineMiles } from '../src/engine/tripEngine.js';

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}`); } else { fail++; console.log(`FAIL  ${label}${extra ? ` — ${extra}` : ''}`); }
};

const feature = (props, coords) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: props });
const MBX = 'dXJuOm1ieHBvaTo2YTQ5ZDNhMi1jNTA2';

// ---- rows ----
const ramen = rowFromFeature(feature({
  name: 'Bokujō Ramen', mapbox_id: MBX, feature_type: 'poi',
  full_address: '516 7th St, Rapid City, South Dakota 57701, United States',
  poi_category_ids: ['food', 'food_and_drink', 'japanese_restaurant', 'restaurant'], operational_status: 'active',
  metadata: {
    phone: '+16057180400', website: 'http://bokujoramen.com/', rating: 4.05,
    open_hours: {
      periods: [{ open: { day: 0, time: '1100' }, close: { day: 0, time: '2000' } }, { open: { day: 2, time: '1100' }, close: { day: 2, time: '2100' } }],
      weekday_text: ['Monday: Closed', 'Tuesday: 11:00 AM - 9:00 PM', 'Wednesday: Closed', 'Thursday: Closed', 'Friday: Closed', 'Saturday: Closed', 'Sunday: 11:00 AM - 8:00 PM'],
    },
  },
}, [-103.2305, 44.081]));
ok(ramen.id === MBX && ramen.source === 'mapbox', 'row carries the Mapbox id and source');
ok(ramen.lat === 44.081 && ramen.lng === -103.2305, 'row coordinates from the geometry');
ok(ramen.primaryType === 'japanese_restaurant' && cuisineLabel(ramen.primaryType, ramen.types) === 'Japanese', 'the specific category leads: Japanese, not "restaurant"');
ok(ramen.phone === '(605) 718-0400', 'phone formatted for a US reader', ramen.phone);
ok(ramen.rating === 4.05 && ramen.userRatingCount === null && ramen.priceLevel === null, 'rating kept, no invented count or price');
ok(ramen.hours?.[0] === 'Monday: Closed' && ramen.hours.length === 7, 'Mapbox weekday text used as the weekly table');
ok(ramen.periods?.[0]?.open?.hour === 11 && ramen.periods[0].close.hour === 20, 'HHMM periods become Google hour/minute');
ok(openAt(ramen.periods, 12 * 60, 0) === 'open', 'open Sunday noon');
ok(openAt(ramen.periods, 12 * 60, 1) === 'closed', 'closed Monday noon');
ok(openAt(ramen.periods, 20 * 60 + 30, 0) === 'closed', 'closed Sunday 8:30 PM');

const cats = (ids) => rowFromFeature(feature({ name: 'x', mapbox_id: MBX, poi_category_ids: ids }, [0, 0]));
ok(cuisineLabel(cats(['food', 'burger_restaurant', 'restaurant']).primaryType) === 'Burgers', 'burger_restaurant reads Burgers');
ok(cuisineLabel(cats(['steakhouse', 'restaurant']).primaryType) === 'Steakhouse', 'steakhouse reads Steakhouse');
ok(cuisineLabel(cats(['barbeque_restaurant', 'restaurant']).primaryType) === 'BBQ', 'barbeque_restaurant reads BBQ');
ok(cuisineLabel(cats(['bakery', 'cafe', 'coffee', 'coffee_shop', 'food', 'food_and_drink']).primaryType) === 'Coffee', 'a Starbucks reads Coffee, not Bakery');
ok(cats(['gas_station']).primaryType === 'gas_station', 'a fuel row stays gas_station (the card\'s fuel test)');
ok(rowFromFeature(feature({ name: 'x', mapbox_id: MBX, operational_status: 'closed' }, [0, 0])).status === 'CLOSED', 'a closed place is marked so search drops it');

// ---- hours built from periods alone ----
const wk = weekdayText(toGooglePeriods([{ open: { day: 2, time: '0700' }, close: { day: 2, time: '2130' } }, { open: { day: 0, time: '1100' }, close: { day: 1, time: '0000' } }]));
ok(wk[0] === 'Monday: Closed' && wk[1] === 'Tuesday: 7:00 AM – 9:30 PM', 'weekly table built Monday-first', wk.slice(0, 2).join(' | '));
ok(wk[6] === 'Sunday: 11:00 AM – 12:00 AM', 'a midnight close reads 12:00 AM', wk[6]);
ok(weekdayText(toGooglePeriods([{ open: { day: 0, time: '0000' } }]))[3] === 'Thursday: Open 24 hours', 'an open with no close is 24 hours');
ok(toGooglePeriods(null) === null && weekdayText(null) === null, 'no hours → null, not an empty week');

// ---- the place page ----
const det = detailsFromFeature(feature({
  name: 'Williams 66 Service', mapbox_id: MBX, poi_category_ids: ['gas_station'],
  metadata: { detailed_description: 'Phillips 66 gas station located in Spearfish, SD.', rating: 4.05, takeout: true, delivery: false, serves_beer: true, wheelchair_accessible: true, primary_photo: 'https://example.com/p.jpg' },
}, [-103.8587, 44.4903]));
ok(det.summary?.startsWith('Phillips 66'), 'description becomes the summary line');
ok(det.amenities.some((a) => a.label === 'Takeout' && a.ok) && det.amenities.some((a) => a.label === 'Delivery' && !a.ok), 'service booleans become ✓ / ✕ chips, only those stated');
ok(det.reviews.length === 0 && det.photos[0]?.url === 'https://example.com/p.jpg', 'no reviews invented; a photo URL is used directly');

// ---- a dropped pin ----
const town = labelFromReverse({ features: [
  feature({ feature_type: 'address', name: '5 North Broadway Avenue', full_address: '5 North Broadway Avenue, Red Lodge, Montana 59068, United States', context: { street: { name: 'North Broadway Avenue' }, place: { name: 'Red Lodge' } } }, [0, 0]),
  feature({ feature_type: 'place', name: 'Red Lodge' }, [0, 0]),
] });
ok(town?.name === 'North Broadway Avenue, Red Lodge' && town.source === 'mapbox', 'an address pin is named road + town', town?.name);
const pass212 = labelFromReverse({ features: [feature({ feature_type: 'street', name: 'Beartooth Highway' }, [0, 0]), feature({ feature_type: 'place', name: 'Cody' }, [0, 0])] });
ok(pass212?.name === 'Beartooth Highway, Cody', 'an open-country pin is named by its highway', pass212?.name);
ok(labelFromReverse({ features: [] }) === null, 'nothing there → null, the coordinate stands');

// ---- along the route ----
const line = Array.from({ length: 201 }, (_, i) => [-103.5, 43 + i * (1 / 69)]); // 200 mi due north
const atStart = corridorSamples(line, { lat: 43, lng: -103.5 });
const miOf = (p) => haversineMiles({ lat: 43, lng: -103.5 }, p);
ok(atStart.length === 8 && miOf(atStart[0]) < 15 && miOf(atStart.at(-1)) <= 121, 'from the start: 8 samples over the next 120 mi', atStart.map((p) => Math.round(miOf(p))).join(','));
const mid = corridorSamples(line, { lat: 43 + 100 / 69, lng: -103.5 });
ok(miOf(mid[0]) >= 90 && miOf(mid.at(-1)) <= 200 && mid.every((p, i) => !i || p.lat > mid[i - 1].lat), 'from mid-route: 10 mi behind to the end, in order', mid.map((p) => Math.round(miOf(p))).join(','));
ok(atStart.every((p) => p.boxMi >= 4), 'every sample searches a box a few miles wide');
const [w, s, e, n] = bboxAround({ lat: 44, lng: -103 }, 10).split(',').map(Number);
ok(Math.abs((n - s) - 20 / 69) < 0.01 && e > w, 'a 10-mile box spans ~20 mi of latitude');

// ---- stamps ----
ok(JSON.stringify(placeStamp({ id: MBX, source: 'mapbox' })) === JSON.stringify({ placeId: MBX, verified: 'mapbox' }), 'a Mapbox row stamps verified: mapbox');
ok(placeStamp({ id: 'ChIJabc', source: 'google' }).verified === 'google', 'a Google row still stamps google');
ok(Object.keys(placeStamp({ id: 123, source: 'osm' })).length === 0, 'a Nominatim row carries no identity');
ok(isMapboxId(MBX) && !isMapboxId('ChIJN1t_tDeuEmsRUsoyG83frY4'), 'Mapbox and Google ids tell apart');
ok(isVerifiedStamp('mapbox') && isVerifiedStamp('google') && !isVerifiedStamp(false), 'mapbox counts as verified for the ✓ tag');
ok(factsSource(MBX) === 'Mapbox' && factsSource('ChIJabc') === 'Google', 'attribution follows the id');
const qt = buildQuickTrip({ start: { lat: 44.49, lng: -103.86 }, dest: { name: 'Hotel Alex Johnson', lat: 44.08, lng: -103.23, id: MBX, source: 'mapbox' }, routePrefs: {} });
ok(qt.days[0].waypoints[1].verified === 'mapbox' && qt.days[0].waypoints[1].placeId === MBX, 'a quick ride to a Mapbox place is stamped mapbox');

// ---- live ----
const token = process.env.VITE_MAPBOX_TOKEN;
if (!token) {
  console.log('\n(no VITE_MAPBOX_TOKEN — live checks skipped)');
} else {
  console.log('\n-- live --');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => realFetch(url, { ...opts, headers: { ...(opts.headers ?? {}), Referer: 'http://localhost:5199/' } });
  _setMapboxToken(token);
  const store = { 'moto.settings.v1': JSON.stringify({ placeData: 'mapbox' }) };
  globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };

  const spearfish = { lat: 44.4906, lng: -103.8597 };
  const rapid = { lat: 44.0805, lng: -103.231 };
  try {
    const fuel = await searchNearby({ category: 'fuel', near: spearfish, radiusMi: 25 });
    ok(fuel.length >= 3 && fuel.every((r) => r.source === 'mapbox' && r.types.includes('gas_station')), 'Fuel near Spearfish: gas stations from Mapbox', `${fuel.length} rows`);
    ok(fuel.every((r) => haversineMiles(spearfish, r) <= 25), 'every fuel row inside the 25-mile radius');
    ok(fuel.every((r) => r.openNow === null || typeof r.openNow === 'boolean'), 'open-now read off the hours (or unknown)');

    const bbq = await searchNearby({ category: 'food', subtype: 'barbecue_restaurant', near: rapid, radiusMi: 25 });
    ok(bbq.length >= 1 && bbq.every((r) => r.types.includes('barbecue_restaurant')), 'BBQ chip in Rapid City returns only BBQ', bbq.map((r) => r.name).join('; '));
    await searchNearby({ category: 'food', subtype: 'bar_and_grill', near: { lat: 45.7833, lng: -108.5007 }, radiusMi: 25 });
    ok(true, 'Bar & grill (a text search held to eating categories) answers without error');

    const tap = await searchNearby({ category: null, query: 'Hotel Alex Johnson', near: rapid, radiusMi: 2, limit: 5, restrict: true });
    ok(/alex johnson/i.test(tap[0]?.name ?? ''), 'a tapped POI resolves by name inside a hard box', tap[0]?.name);

    const i90 = [[-103.86, 44.49], [-103.61, 44.45], [-103.51, 44.41], [-103.39, 44.3], [-103.29, 44.16], [-103.23, 44.08]];
    const along = await searchNearby({ category: 'fuel', near: spearfish, route: i90 });
    ok(along.length >= 5 && new Set(along.map((r) => r.id)).size === along.length, 'Fuel along I-90 Spearfish → Rapid City: sampled, no duplicates', `${along.length} rows`);

    const d = await mapboxDetails(fuel[0].id);
    ok(d && d.id === fuel[0].id && Array.isArray(d.amenities), 'Places Details answers for a search row', d ? `${d.name} ★${d.rating ?? '–'}` : 'null');

    const pin = await mapboxReverse({ lat: 45.1872, lng: -109.2475 });
    ok(/Red Lodge/.test(pin?.name ?? ''), 'a pin in Red Lodge is named by Geocoding v6', pin?.name);

    const eta = await mapboxTrafficEta({ ...spearfish, heading: 110 }, [{ lat: 44.4108, lng: -103.4591 }, rapid]);
    ok(eta.seconds > 1800 && eta.miles > 40 && eta.miles < 75, 'driving-traffic clock over Sturgis to Rapid City', `${Math.round(eta.seconds / 60)} min, ${eta.miles.toFixed(1)} mi`);
  } catch (e) {
    ok(false, 'live checks ran', e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

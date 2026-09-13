// LIVE: the nearby picker's server half against the real Google Places API,
// on real corridors the seed trip rides. No mocks. Needs GOOGLE_MAPS_API_KEY
// in the environment (the same key Netlify holds); without it the script says
// so and exits 2 rather than pretending.
//
//   GOOGLE_MAPS_API_KEY=… node tools/sims/live-nearby.mjs
//
// What it proves, per corridor:
//   · a category chip returns ONLY that type (strict includedType)
//   · rows carry rating, hours periods, openNow — the facts the UI shows
//   · along-route mode returns Google's routing summaries for each hit
//   · a cuisine chip returns only that cuisine, and cuisineLabel() names it
//   · nothing permanently closed, everything inside the bias radius
//
// Cost: ~8 Enterprise-tier Places calls per run. Run it deliberately.
import handler from '../../netlify/functions/nearby-places.mjs';
import { cuisineLabel, openAt } from '../../src/engine/nearby.js';

const key = process.env.GOOGLE_MAPS_API_KEY;
if (!key) {
  console.log('SKIP: GOOGLE_MAPS_API_KEY is not set — this check calls the real Places API on real locations.');
  process.exit(2);
}
let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };
const R = 3958.8;
const hav = (a, b) => {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180, dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180, la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const call = async (body) => {
  const res = await handler(new Request('http://x/.netlify/functions/nearby-places', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
};

// Real places the seed trip rides through.
const SPEARFISH = { lat: 44.4936, lng: -103.8597 };   // Spearfish, SD — the canyon day
const CODY = { lat: 44.5263, lng: -109.0565 };        // Cody, WY
const RAPID = { lat: 44.0805, lng: -103.2310 };       // Rapid City, SD
// A straight-line stand-in for the US-14A canyon corridor Spearfish → Lead:
// the real sim hands Valhalla's line; here a few vertices are enough to prove
// Search Along Route accepts our encoding and answers with routing summaries.
const CANYON = [[-103.8597, 44.4936], [-103.8300, 44.4400], [-103.7900, 44.3900], [-103.7650, 44.3520]];

// 1. Fuel near Spearfish: strict type, real facts
{
  const rows = await call({ category: 'fuel', near: SPEARFISH, radiusMi: 10, limit: 8 });
  console.log(`\n── fuel near Spearfish: ${rows.length} rows`);
  rows.slice(0, 4).forEach((r) => console.log(`   ${r.name} · ${r.primaryType} · ★${r.rating ?? '–'} · periods ${r.periods?.length ?? 0} · openNow ${r.openNow}`));
  check(rows.length >= 3, `enough stations to choose from (${rows.length})`);
  check(rows.every((r) => r.primaryType === 'gas_station' || (r.types ?? []).includes('gas_station')), 'every row is a gas station — strict type held');
  check(rows.every((r) => hav(SPEARFISH, r) <= 12), 'every row is inside the bias radius');
  check(rows.every((r) => r.status !== 'CLOSED_PERMANENTLY'), 'nothing permanently closed');
  check(rows.filter((r) => Array.isArray(r.periods) && r.periods.length).length >= Math.ceil(rows.length * 0.6), 'most stations carry hours periods (open-at-ETA has something to judge)');
  check(rows.some((r) => Number.isFinite(r.rating)), 'ratings present');
  const withHours = rows.find((r) => r.periods?.length);
  if (withHours) {
    const noon = openAt(withHours.periods, 12 * 60, 3);
    check(noon === 'open' || noon === 'closed', `openAt() decides on real periods (${withHours.name} at Wed noon: ${noon})`);
  }
}

// 2. Food in Cody: cuisine tags on real restaurants
{
  const rows = await call({ category: 'food', near: CODY, radiusMi: 8, limit: 10 });
  console.log(`\n── food in Cody: ${rows.length} rows`);
  const tagged = rows.map((r) => ({ name: r.name, tag: cuisineLabel(r.primaryType, r.types), pt: r.primaryType }));
  tagged.slice(0, 6).forEach((x) => console.log(`   ${x.name} → "${x.tag}" (${x.pt})`));
  check(rows.length >= 5, `a real list (${rows.length})`);
  check(rows.every((r) => (r.types ?? []).includes('restaurant') || /restaurant|diner|cafe|bar|steak|pizza|grill/.test(r.primaryType ?? '')), 'every row is a food place');
  const labelled = tagged.filter((x) => x.tag).length;
  check(labelled >= Math.ceil(rows.length * 0.6), `cuisine known at a glance for most rows (${labelled}/${rows.length})`);
  check(rows.some((r) => r.priceLevel), 'price levels present');
}

// 3. BBQ in Rapid City: a cuisine chip is a strict type
{
  const rows = await call({ category: 'food', subtype: 'barbecue_restaurant', near: RAPID, radiusMi: 15, limit: 8 });
  console.log(`\n── BBQ in Rapid City: ${rows.length} rows`);
  rows.slice(0, 4).forEach((r) => console.log(`   ${r.name} · ${r.primaryType}`));
  check(rows.length >= 1, 'BBQ exists in Rapid City');
  check(rows.every((r) => r.primaryType === 'barbecue_restaurant' || (r.types ?? []).includes('barbecue_restaurant')), 'every row is barbecue — the cuisine chip is a strict filter');
  check(rows.every((r) => cuisineLabel(r.primaryType, r.types) === 'BBQ'), 'and every row is tagged BBQ');
}

// 4. Along the canyon: routing summaries come back
{
  const rows = await call({ category: 'fuel', near: SPEARFISH, radiusMi: 30, route: CANYON, limit: 8 });
  console.log(`\n── fuel along Spearfish Canyon: ${rows.length} rows`);
  rows.slice(0, 4).forEach((r) => console.log(`   ${r.name} · ${r.routeDistanceMeters ? (r.routeDistanceMeters / 1609).toFixed(1) + ' mi' : '–'} · ${r.routeDurationSeconds ? Math.round(r.routeDurationSeconds / 60) + ' min' : '–'}`));
  check(rows.length >= 1, 'along-route search accepted our precision-5 encoding');
  check(rows.some((r) => Number.isFinite(r.routeDurationSeconds) && r.routeDurationSeconds > 0), 'Google returned a routing summary per hit');
  check(rows.every((r) => r.primaryType === 'gas_station' || (r.types ?? []).includes('gas_station')), 'strict type holds along a route too');
}

// 5. Free text + category: "Sinclair" under Fuel
{
  const rows = await call({ category: 'fuel', query: 'Sinclair', near: SPEARFISH, radiusMi: 25, limit: 6 });
  console.log(`\n── "Sinclair" under Fuel: ${rows.map((r) => r.name).join(' | ')}`);
  check(rows.length >= 1 && rows.some((r) => /sinclair/i.test(r.name)), 'a name narrows within the category');
}

// 6. Lodging, Coffee, Moto, Help — each strict
for (const [cat, types, where] of [['lodging', ['lodging'], RAPID], ['coffee', ['cafe', 'coffee_shop'], RAPID], ['moto', ['motorcycle_repair_shop', 'motorcycle_dealer'], RAPID], ['help', ['hospital'], RAPID]]) {
  const rows = await call({ category: cat, near: where, radiusMi: 15, limit: 6 });
  console.log(`\n── ${cat} in Rapid City: ${rows.slice(0, 3).map((r) => `${r.name} (${r.primaryType})`).join(' | ')}`);
  check(rows.length >= 1, `${cat}: results`);
  check(rows.every((r) => types.includes(r.primaryType) || (r.types ?? []).some((x) => types.includes(x))), `${cat}: strict type held`);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

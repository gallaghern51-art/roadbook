// The rider's own place browse — nearby, along the route, or near a stop —
// with the facts that make a row decidable at a glance.
//
// What Google Maps gives is a category list with rating, price, distance and
// (while navigating) a detour cost. What it cannot give is anything about a
// PLANNED day: which pass of a loop a candidate sits on, how far off the road
// you are actually riding it is, or whether it is open when YOU get there.
// The engine already knows all three, so every row here carries them.
//
//   searchNearby()   the server call (Places Enterprise, rider-driven only)
//   enrichAlong()    off-route miles + along-route position from the day's line
//   openAt()         open/closed at a minute-of-day, from Google's periods
//   detourMinutes()  the real cost of one candidate, measured by Valhalla

import { projectOnChain, chainCumMiles, haversineMiles } from './tripEngine.js';
import { valhallaRoute } from './routing.js';

const FN = '/.netlify/functions/nearby-places';
let skipUntil = 0; // a keyless deploy costs one probe, not one per tap

export const CATEGORIES = [
  { id: 'fuel', label: 'Fuel', glyph: '⛽' },
  { id: 'food', label: 'Food', glyph: '🍽' },
  { id: 'coffee', label: 'Coffee', glyph: '☕' },
  { id: 'lodging', label: 'Lodging', glyph: '🛏' },
  { id: 'sights', label: 'Sights', glyph: '◎' },
  { id: 'moto', label: 'Moto', glyph: '🔧' },
  { id: 'help', label: 'Help', glyph: '✚' },
];

// Under Food: what KIND of food, at a glance. Ids are Google Places (New)
// types, so a chip is a strict `includedType` on the server and the tag on a
// row comes straight from the place's `primaryType` — nothing is guessed from
// the name. "Any" is the Food chip alone.
export const CUISINES = [
  { id: 'diner', label: 'Diner' },
  { id: 'breakfast_restaurant', label: 'Breakfast' },
  { id: 'hamburger_restaurant', label: 'Burgers' },
  { id: 'barbecue_restaurant', label: 'BBQ' },
  { id: 'pizza_restaurant', label: 'Pizza' },
  { id: 'mexican_restaurant', label: 'Mexican' },
  { id: 'steak_house', label: 'Steak' },
  { id: 'seafood_restaurant', label: 'Seafood' },
  { id: 'bar_and_grill', label: 'Bar & grill' },
  { id: 'italian_restaurant', label: 'Italian' },
  { id: 'chinese_restaurant', label: 'Chinese' },
  { id: 'sandwich_shop', label: 'Sandwiches' },
];

const CUISINE_WORDS = {
  american_restaurant: 'American', diner: 'Diner', breakfast_restaurant: 'Breakfast', brunch_restaurant: 'Brunch',
  hamburger_restaurant: 'Burgers', fast_food_restaurant: 'Fast food', barbecue_restaurant: 'BBQ', pizza_restaurant: 'Pizza',
  mexican_restaurant: 'Mexican', steak_house: 'Steakhouse', seafood_restaurant: 'Seafood', bar_and_grill: 'Bar & grill',
  bar: 'Bar', pub: 'Pub', italian_restaurant: 'Italian', chinese_restaurant: 'Chinese', thai_restaurant: 'Thai',
  japanese_restaurant: 'Japanese', sushi_restaurant: 'Sushi', indian_restaurant: 'Indian', vietnamese_restaurant: 'Vietnamese',
  korean_restaurant: 'Korean', greek_restaurant: 'Greek', mediterranean_restaurant: 'Mediterranean', french_restaurant: 'French',
  vegan_restaurant: 'Vegan', vegetarian_restaurant: 'Vegetarian', sandwich_shop: 'Sandwiches', bakery: 'Bakery',
  cafe: 'Café', coffee_shop: 'Coffee', ice_cream_shop: 'Ice cream', food_court: 'Food court', meal_takeaway: 'Takeaway',
  restaurant: '', // bare "restaurant" says nothing — leave the tag off
};

/**
 * "Mexican", "BBQ", "Steakhouse" — from Google's primaryType (or the first
 * cuisine-ish type). `prefer` is the cuisine chip the rider tapped: Google's
 * strict filter matches ANY of a place's types, so a steakhouse that also
 * smokes brisket comes back under BBQ with primaryType steak_house — and the
 * rider who asked for BBQ should read BBQ on it (caught live, Sep 13, 2026).
 */
export function cuisineLabel(primaryType, types = [], prefer = null) {
  const pick = (t) => (t in CUISINE_WORDS ? CUISINE_WORDS[t] : null);
  if (prefer && (primaryType === prefer || (types ?? []).includes(prefer)) && pick(prefer)) return pick(prefer);
  const fromPrimary = pick(primaryType);
  if (fromPrimary) return fromPrimary;
  for (const t of types ?? []) { const w = pick(t); if (w) return w; }
  if (primaryType && /_restaurant$/.test(primaryType)) {
    const w = primaryType.replace(/_restaurant$/, '').replace(/_/g, ' ');
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  return '';
}

/**
 * @param {object} o
 * @param {string|null} o.category  one of CATEGORIES[].id, or null for free text
 * @param {string|null} [o.subtype] a CUISINES[].id under Food
 * @param {string} [o.query]
 * @param {{lat:number,lng:number}} o.near
 * @param {number} [o.radiusMi]
 * @param {Array<[number,number]>} [o.route]  [lng,lat] vertices → along-route mode
 */
export async function searchNearby({ category, subtype = null, query, near, radiusMi = 25, route = null, limit = 8, restrict = false }) {
  if (Date.now() < skipUntil) throw new Error('nearby backoff');
  let res;
  try {
    res = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, subtype, query, near, radiusMi, route, limit, restrict }),
    });
  } catch (e) {
    skipUntil = Date.now() + 5 * 60_000;
    throw e;
  }
  if (!res.ok) {
    skipUntil = Date.now() + (res.status === 501 || res.status === 404 ? 30 : 5) * 60_000;
    throw new Error(`nearby-places ${res.status}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('nearby-places bad shape');
  return json.map((r) => ({ ...r, source: 'google' }));
}

/**
 * Stamp each result with where it sits relative to the day's routed line:
 *   offRouteMi  perpendicular distance to the nearest point of the line
 *   alongMi     that point's along-route position
 *   aheadMi     alongMi − fromAlong (negative = behind the bike / the stop)
 *   distMi      straight-line from `near`
 * Pure; no network. A day with no routed line gets distMi only.
 */
export function enrichAlong(results, chain, { near, fromAlong = 0, cum = null } = {}) {
  const cumMi = chain?.length > 1 ? (cum ?? chainCumMiles(chain)) : null;
  return results.map((r) => {
    const out = { ...r, distMi: near ? haversineMiles(near, r) : null };
    if (cumMi) {
      const p = projectOnChain(chain, r);
      if (p) {
        out.offRouteMi = p.off;
        out.alongMi = cumMi[p.i] + p.f * (cumMi[p.i + 1] - cumMi[p.i]);
        out.aheadMi = out.alongMi - fromAlong;
      }
    }
    return out;
  });
}

/**
 * 'open' | 'closed' | 'unknown' at minute-of-day `min` on weekday `dow`
 * (0 = Sunday, Google's convention). Google's periods are {open:{day,hour,
 * minute}, close:{...}}; a place with an open and no close is 24h.
 */
export function openAt(periods, min, dow) {
  if (!Array.isArray(periods) || !periods.length || !Number.isFinite(min)) return 'unknown';
  const at = ((dow % 7) + 7) % 7;
  for (const p of periods) {
    const o = p.open, c = p.close;
    if (!o) continue;
    if (!c) return 'open'; // always open
    const oMin = o.hour * 60 + (o.minute ?? 0);
    const cMin = c.hour * 60 + (c.minute ?? 0);
    if (o.day === c.day) {
      if (o.day === at && min >= oMin && min < cMin) return 'open';
    } else {
      // spans midnight: open on o.day from oMin to 24:00, and on c.day until cMin
      if (o.day === at && min >= oMin) return 'open';
      if (c.day === at && min < cMin) return 'open';
    }
  }
  return 'closed';
}

/**
 * The real cost of putting `place` between `from` and `to`: minutes and miles
 * via the place, minus the direct leg — measured by the same motorcycle router
 * the plan is built on. Two calls; used only for the row the rider taps.
 */
export async function detourCost(from, place, to, routePrefs) {
  const [via, direct] = await Promise.all([
    valhallaRoute(from, [place, to], routePrefs),
    to ? valhallaRoute(from, [to], routePrefs) : Promise.resolve(null),
  ]);
  const vMin = (via.summary?.time ?? 0) / 60, vMi = via.summary?.length ?? 0;
  const dMin = (direct?.summary?.time ?? 0) / 60, dMi = direct?.summary?.length ?? 0;
  return { minutes: Math.max(0, vMin - dMin), miles: Math.max(0, vMi - dMi), toPlaceMin: (via.legs?.[0]?.summary?.time ?? 0) / 60 };
}

/** Google's PRICE_LEVEL_* enum → "$".."$$$$", or ''. */
export function priceGlyph(level) {
  const n = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 }[level];
  return n ? '$'.repeat(n) : '';
}

/**
 * The margin each hard gate has AFTER a point in the day — what a detour eats
 * into. Given the day's simulated timeline, returns [{ label, by, marginMin }]
 * for gates on stops at or after `fromIndex` (all gates when null). A
 * candidate whose measured detour exceeds a margin breaks that gate; that is
 * the fact Google cannot know and the one a rider most needs on the row.
 */
export function gateSlack(day, timeline, parseTime, fromIndex = null) {
  const out = [];
  for (const g of day?.gates ?? []) {
    const i = (day.waypoints ?? []).findIndex((w) => w.id === g.waypointId);
    if (i < 0 || (fromIndex != null && i < fromIndex)) continue;
    const stop = timeline?.stops?.[i];
    if (!stop) continue;
    const by = parseTime(g.by);
    if (!Number.isFinite(by)) continue;
    out.push({ label: g.label, by: g.by, marginMin: Math.round(by - stop.arrive) });
  }
  return out;
}

// ---- OpenMapTiles POI classes → the picker's categories ----
// A tapped vector POI carries OSM's `class`; this is the bridge to the chip a
// rider would have pressed, so the Google lookup can be strict-typed and the
// pin/card wear the right glyph. Unknown classes are a plain place.
const POI_CLASS = {
  fuel: 'fuel',
  restaurant: 'food', fast_food: 'food', bar: 'food', pub: 'food', food_court: 'food',
  cafe: 'coffee', bakery: 'coffee', ice_cream: 'coffee',
  lodging: 'lodging', hotel: 'lodging', motel: 'lodging', campsite: 'lodging', camping: 'lodging',
  hospital: 'help', doctors: 'help', pharmacy: 'help', clinic: 'help',
  attraction: 'sights', park: 'sights', viewpoint: 'sights', museum: 'sights', monument: 'sights', castle: 'sights', zoo: 'sights', information: 'sights',
  car: 'moto', car_repair: 'moto', motorcycle: 'moto',
  // Mapbox Streets v8 poi_label: `class` buckets and `maki` icon names
  food_and_drink: 'food', 'fast-food': 'food', food_and_drink_stores: null,
  medical: 'help', doctor: 'help',
  park_like: 'sights', landmark: 'sights', arts_and_entertainment: 'sights', 'ice-cream': 'coffee',
  'car-repair': 'moto', 'charging-station': 'fuel',
};
export function poiCategory(cls, subclass) {
  return POI_CLASS[subclass] ?? POI_CLASS[cls] ?? null; // the specific (subclass / maki) wins over the bucket (class)
}
export function poiGlyph(cls, subclass) {
  const cat = poiCategory(cls, subclass);
  return CATEGORIES.find((c) => c.id === cat)?.glyph ?? '📍';
}

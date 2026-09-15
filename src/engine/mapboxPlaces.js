// Mapbox as the places database — the preview of docs/mapbox-places-plan.md.
//
//   mapboxSearch()      Search Box /category and /forward — the picker, the
//                       pill, the POI tap, Ride Mode's quick add
//   mapboxDetails()     Places Details (preview) — the place page
//   mapboxReverse()     Geocoding v6 reverse — a dropped pin's road and town
//   mapboxTrafficEta()  Directions driving-traffic — Ride Mode's clock
//   mapboxGeocode()     Search Box /forward — the plain place search box
//
// Every function answers in the SAME shape as its Google half
// (netlify/lib/places-core.mjs, place-details.mjs, reverse-geocode.mjs,
// google-route.mjs), so the picker, the cards, the place page and the traffic
// anchor never learn which database spoke. Rows carry `source: 'mapbox'`.
//
// Straight from the browser with the public, URL-restricted `pk.` token that
// already draws the map — no function to proxy through, no key to hide.
//
// Measured against the live APIs, Sep 14, 2026:
//   · category and forward rows carry name, address, categories, phone,
//     website and weekly hours in Google's day convention (0 = Sunday) with
//     "HHMM" times — and no rating, price or photos anywhere in MT/WY/SD
//   · Places Details adds a rating (no count), a one-line description,
//     operational status and service booleans; no photos or price seen
//   · `proximity` is only a BIAS ("Cowboy Cafe" near Cody answered Dubois);
//     `bbox` is a hard boundary, so a tapped place is searched inside one
//   · there is no search-along-route: the day's line is sampled and each
//     sample searched in a box; `enrichAlong` then measures off-route/ahead
//     exactly as it does for Google rows

import { MAPBOX_TOKEN } from './basemaps.js';
import { haversineMiles } from './tripEngine.js';

const API = 'https://api.mapbox.com';
const SB = `${API}/search/searchbox/v1`;

// chip → Search Box canonical categories (checked against /list/category)
const CATEGORY = {
  fuel: ['gas_station'],
  food: ['restaurant'],
  coffee: ['coffee_shop', 'cafe'],
  lodging: ['lodging'],
  sights: ['tourist_attraction', 'viewpoint'],
  moto: ['motorcycle_dealer'],
  help: ['hospital'],
};

// The Food sub-chips carry Google ids (nearby.js CUISINES). Most have a Mapbox
// category of their own; "Bar & grill" does not, so it is a text search held
// to eating and drinking categories rather than a category it is not.
const CUISINE = {
  diner: 'diner_restaurant',
  breakfast_restaurant: 'breakfast_restaurant',
  hamburger_restaurant: 'burger_restaurant',
  barbecue_restaurant: 'barbeque_restaurant',
  pizza_restaurant: 'pizza_restaurant',
  mexican_restaurant: 'mexican_restaurant',
  steak_house: 'steakhouse',
  seafood_restaurant: 'seafood_restaurant',
  bar_and_grill: { q: 'grill', cats: ['restaurant', 'bar', 'pub', 'sports_bar', 'gastropub'] },
  italian_restaurant: 'italian_restaurant',
  chinese_restaurant: 'chinese_restaurant',
  sandwich_shop: 'sandwich_shop',
};

// Mapbox category ids → the Google type words the rest of the app reads
// (nearby.js cuisineLabel, the fuel check on a card). Ids not listed pass
// through unchanged — most Mapbox restaurant ids already match Google's.
const TO_GOOGLE = {
  diner_restaurant: 'diner',
  burger_restaurant: 'hamburger_restaurant',
  barbeque_restaurant: 'barbecue_restaurant',
  steakhouse: 'steak_house',
  fast_food: 'fast_food_restaurant',
  hotel: 'lodging',
  motel: 'lodging',
  bed_and_breakfast: 'lodging',
};
const toGoogle = (id) => TO_GOOGLE[id] ?? id;

// Buckets that say nothing about WHAT the place is; the row's primaryType is
// the most specific id that is not one of these.
const GENERIC = new Set(['food', 'food_and_drink', 'restaurant', 'shopping', 'services', 'coffee', 'cafe', 'bar', 'car_dealership', 'lodging', 'hotel', 'outdoors', 'tourist_attraction']);
function primaryId(ids) {
  const specific = ids.filter((id) => !GENERIC.has(id));
  const rank = (id) => (/_restaurant$|steakhouse|gastropub|pub$|_bar$/.test(id) ? 0 : /coffee_shop|sandwich_shop|fast_food/.test(id) ? 1 : 2);
  return specific.sort((a, b) => rank(a) - rank(b))[0] ?? ids.find((id) => id !== 'food' && id !== 'food_and_drink') ?? ids[0] ?? null;
}

// ---- hours ----

const hm = (s) => {
  const n = String(s ?? '').padStart(4, '0');
  return { hour: Number(n.slice(0, 2)) || 0, minute: Number(n.slice(2, 4)) || 0 };
};

/** Mapbox `{open:{day,time:"0800"}}` → Google `{open:{day,hour,minute}}`, which openAt() reads. */
export function toGooglePeriods(periods) {
  if (!Array.isArray(periods) || !periods.length) return null;
  return periods
    .filter((p) => p?.open && Number.isFinite(p.open.day))
    .map((p) => ({ open: { day: p.open.day, ...hm(p.open.time) }, ...(p.close ? { close: { day: p.close.day, ...hm(p.close.time) } } : {}) }));
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const clock = ({ hour, minute }) => {
  const hh = hour % 24;
  return `${hh % 12 || 12}:${String(minute).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};

/** Monday-first "Monday: 7:00 AM – 9:00 PM" lines from periods — Google's weekdayDescriptions shape. */
export function weekdayText(periods) {
  if (!periods?.length) return null;
  if (periods.some((p) => !p.close)) return DAYS.map((d) => `${d}: Open 24 hours`);
  return DAYS.map((d, i) => {
    const day = (i + 1) % 7; // periods count Sunday as 0; the list starts on Monday
    const spans = periods.filter((p) => p.open.day === day).map((p) => `${clock(p.open)} – ${clock(p.close)}`);
    return `${d}: ${spans.length ? spans.join(', ') : 'Closed'}`;
  });
}

// ---- rows ----

function formatPhone(s) {
  if (!s) return null;
  const d = String(s).replace(/\D/g, '');
  const n = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(s);
}

const PRICE = [null, 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];
const priceLevel = (v) => PRICE[typeof v === 'number' ? v : (String(v ?? '').match(/\$/g) ?? []).length] ?? null;

/** One Search Box / Details feature → the row shape the Google half returns. */
export function rowFromFeature(f) {
  const p = f?.properties ?? {};
  const m = p.metadata ?? {};
  const [glng, glat] = f?.geometry?.coordinates ?? [];
  const ids = Array.isArray(p.poi_category_ids) ? p.poi_category_ids : [];
  const periods = toGooglePeriods(m.open_hours?.periods);
  const primary = primaryId(ids);
  const status = String(p.operational_status ?? '').toLowerCase();
  return {
    id: p.mapbox_id,
    name: p.name ?? '',
    detail: p.full_address ?? p.place_formatted ?? '',
    lat: Number.isFinite(glat) ? glat : p.coordinates?.latitude,
    lng: Number.isFinite(glng) ? glng : p.coordinates?.longitude,
    types: ids.map(toGoogle),
    primaryType: primary ? toGoogle(primary) : (p.feature_type && p.feature_type !== 'poi' ? p.feature_type : ''),
    status: status && status !== 'active' ? status.toUpperCase() : '',
    hours: Array.isArray(m.open_hours?.weekday_text) && m.open_hours.weekday_text.length === 7 ? m.open_hours.weekday_text : weekdayText(periods),
    periods,
    openNow: null, // computed by the caller from periods (nearby.js searchNearby)
    rating: Number.isFinite(m.rating) ? m.rating : null,
    userRatingCount: Number.isFinite(m.review_count) ? m.review_count : null,
    priceLevel: priceLevel(m.price_level),
    phone: formatPhone(m.phone),
    websiteUri: m.website ?? null,
    featureType: p.feature_type ?? 'poi',
    source: 'mapbox',
  };
}

let tokenOverride = null;
/** Test seam: the node check script has no Vite env, so it hands the token in. */
export function _setMapboxToken(t) { tokenOverride = t || null; }

/** Whether Mapbox can answer at all on this build (placesProvider picks Google without it). */
export const hasMapboxToken = () => !!(tokenOverride ?? MAPBOX_TOKEN);

function token() {
  const t = tokenOverride ?? MAPBOX_TOKEN;
  if (!t) throw new Error('Mapbox token not configured');
  return t;
}

async function sbGet(path, params, signal) {
  const u = new URL(`${SB}/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
  u.searchParams.set('access_token', token());
  const res = await fetch(u, { signal });
  if (!res.ok) {
    const e = new Error(`mapbox search ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  return Array.isArray(j?.features) ? j.features : [];
}

/** "minLng,minLat,maxLng,maxLat" for a square of half-side `mi` around a point. */
export function bboxAround({ lat, lng }, mi) {
  const dLat = mi / 69.0;
  const dLng = mi / (69.17 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(5)).join(',');
}

// No search-along-route at Mapbox: sample the line from a little behind the
// point the rider is at to a ride ahead of it, and search a box around each
// sample. Boxes overlap along the line and reach a few miles either side.
const BEHIND_MI = 10;
const AHEAD_MI = 120;
const STEP_MI = 15;
const MAX_SAMPLES = 8;

/** route: [[lng,lat], …] → [{ lat, lng, boxMi }] centred on the stretch around `near`. */
export function corridorSamples(route, near) {
  const pts = route.map(([lng, lat]) => ({ lat, lng })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (pts.length < 2) return [{ ...near, boxMi: 10 }];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineMiles(pts[i - 1], pts[i]));
  let at = 0;
  if (near && Number.isFinite(near.lat)) {
    let best = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = haversineMiles(near, pts[i]);
      if (d < best) { best = d; at = i; }
    }
  }
  const from = Math.max(0, cum[at] - BEHIND_MI);
  const to = Math.min(cum[cum.length - 1], cum[at] + AHEAD_MI);
  const span = Math.max(0, to - from);
  const n = Math.max(1, Math.min(MAX_SAMPLES, Math.ceil(span / STEP_MI)));
  const step = span / n;
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = from + step * (k + 0.5);
    while (j < cum.length - 2 && cum[j + 1] < target) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const f = Math.min(1, Math.max(0, (target - cum[j]) / seg));
    out.push({ lat: pts[j].lat + f * (pts[j + 1].lat - pts[j].lat), lng: pts[j].lng + f * (pts[j + 1].lng - pts[j].lng), boxMi: step / 2 + 4 });
  }
  return out;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Hotels arrive once per room-type feed; the same name within 200 m is one place.
function dedupe(rows) {
  const ids = new Set();
  const out = [];
  for (const r of rows) {
    if (!r.id || ids.has(r.id) || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue;
    ids.add(r.id);
    if (out.some((o) => norm(o.name) === norm(r.name) && haversineMiles(o, r) < 0.125)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Search Box behind the picker's contract — same arguments as searchNearby().
 * Category chips use /category, text uses /forward (held to the chip's
 * categories when both are given). Along a route, the line is sampled.
 */
export async function mapboxSearch({ category = null, subtype = null, query = '', near, radiusMi = 25, route = null, limit = 8, restrict = false, signal } = {}) {
  token();
  const text = String(query ?? '').trim();
  let cats = category ? CATEGORY[category] ?? null : null;
  let q = text;
  if (category === 'food' && subtype && CUISINE[subtype]) {
    const c = CUISINE[subtype];
    if (typeof c === 'string') cats = [c];
    else { cats = c.cats; q = [c.q, text].filter(Boolean).join(' '); }
  }
  if (!cats && q.length < 2) return [];
  if (!near || !Number.isFinite(near.lat) || !Number.isFinite(near.lng)) throw new Error('need near {lat,lng}');

  const along = Array.isArray(route) && route.length > 1;
  const centers = along ? corridorSamples(route, near) : [{ lat: near.lat, lng: near.lng, boxMi: restrict ? radiusMi : null }];
  const tasks = [];
  for (const c of centers) {
    const params = {
      proximity: `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`,
      bbox: c.boxMi ? bboxAround(c, c.boxMi) : null,
      language: 'en',
    };
    if (q.length >= 2) {
      tasks.push(sbGet('forward', { ...params, q, limit: 10, types: cats ? 'poi' : 'poi,place,address', poi_category: cats?.join(',') }, signal));
    } else {
      // along a route one category per box is enough; near a point, every one
      for (const cat of along ? cats.slice(0, 1) : cats) {
        tasks.push(sbGet(`category/${cat}`, { ...params, limit: along ? 10 : Math.min(25, Math.max(10, limit * 2)) }, signal));
      }
    }
  }
  const settled = await Promise.allSettled(tasks);
  const ok = settled.filter((s) => s.status === 'fulfilled');
  if (!ok.length && settled.length) throw settled[0].reason;

  let rows = dedupe(ok.flatMap((s) => s.value.map(rowFromFeature))).filter((r) => !/CLOSED/.test(r.status));
  if (along) return rows.slice(0, 30);
  const dist = (r) => haversineMiles(near, r);
  // a category near a point is bounded by the radius the caller asked for;
  // a named search may legitimately be farther (the pill searching a town)
  if (cats && !text) rows = rows.filter((r) => dist(r) <= radiusMi);
  return rows.sort((a, b) => dist(a) - dist(b)).slice(0, limit);
}

/** The plain place search box (geocode.js): places, towns and addresses near a point. */
export async function mapboxGeocode(query, near, { signal } = {}) {
  const features = await sbGet('forward', {
    q: query,
    proximity: near && Number.isFinite(near.lat) ? `${near.lng.toFixed(5)},${near.lat.toFixed(5)}` : null,
    types: 'poi,place,address,street',
    limit: 6,
    language: 'en',
  }, signal);
  return features.map(rowFromFeature).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

// ---- the place page ----

/** One Places Details feature → the place-details.mjs shape (no reviews; Mapbox has none). */
export function detailsFromFeature(f) {
  if (!f?.properties?.mapbox_id) return null;
  const row = rowFromFeature(f);
  const m = f.properties.metadata ?? {};
  const amenities = [
    ['Dine-in', m.dine_in], ['Takeout', m.takeout], ['Delivery', m.delivery], ['Reservations', m.reservable],
    ['Drive-through', m.drive_through], ['Breakfast', m.serves_breakfast], ['Brunch', m.serves_brunch],
    ['Lunch', m.serves_lunch], ['Dinner', m.serves_dinner], ['Beer', m.serves_beer], ['Wine', m.serves_wine],
    ['Vegetarian', m.serves_vegetarian_diet], ['Vegan', m.serves_vegan_diet], ['Outdoor seating', m.outdoor_seating],
    ['Wi-Fi', m.wifi], ['Parking', m.parking_available], ['Good for groups', m.good_for_groups],
    ['Dogs OK', m.pets_allowed], ['Kids', m.good_for_kids], ['Wheelchair accessible', m.wheelchair_accessible],
  ].filter(([, v]) => typeof v === 'boolean').map(([label, ok]) => ({ label, ok }));
  const photos = [...(Array.isArray(m.photos) ? m.photos : []), ...(m.primary_photo ? [].concat(m.primary_photo) : [])]
    .map((ph) => (typeof ph === 'string' ? { url: ph } : ph))
    .filter((ph) => ph?.url)
    .slice(0, 5)
    .map((ph) => ({ name: ph.url, url: ph.url, w: ph.width ?? null, h: ph.height ?? null, by: [] }));
  return { ...row, summary: m.detailed_description ?? null, overview: null, reviews: [], amenities, photos };
}

export async function mapboxDetails(id, { signal } = {}) {
  const u = new URL(`${API}/search/details/v1/retrieve/${encodeURIComponent(id)}`);
  // Details is priced per request BY attribute set (private preview). `venue`
  // is the rating, description and amenities the page adds; `visit` (hours,
  // phone, website) is already on the search row the page opens from, and no
  // photos come back in this region — so those two sets are not paid for.
  // Measured Sep 14, 2026: basic,venue returns the same rating, description
  // and amenity booleans as all four sets.
  u.searchParams.set('attribute_sets', 'basic,venue');
  u.searchParams.set('language', 'en');
  u.searchParams.set('access_token', token());
  const res = await fetch(u, { signal });
  if (!res.ok) return null;
  return detailsFromFeature(await res.json());
}

// ---- a dropped pin's name ----

/** Geocoding v6 reverse features → reverse-geocode.mjs's `{ name, detail, road, locality, source }`. */
export function labelFromReverse(json) {
  const fs = Array.isArray(json?.features) ? json.features : [];
  const type = (f) => f?.properties?.feature_type;
  const road = fs.find((f) => type(f) === 'street') ?? fs.find((f) => type(f) === 'address');
  const town = fs.find((f) => type(f) === 'place') ?? fs.find((f) => type(f) === 'locality');
  const roadName = road ? (type(road) === 'address' ? road.properties.context?.street?.name ?? '' : road.properties.name ?? '') : '';
  const locality = town?.properties?.name ?? road?.properties?.context?.place?.name ?? '';
  const name = roadName ? (locality ? `${roadName}, ${locality}` : roadName) : locality;
  if (!name) return null;
  return { name, detail: (road ?? town)?.properties?.full_address ?? '', road: roadName, locality, source: 'mapbox' };
}

export async function mapboxReverse({ lat, lng }, { signal } = {}) {
  const u = new URL(`${API}/search/geocode/v6/reverse`);
  u.searchParams.set('longitude', lng.toFixed(5));
  u.searchParams.set('latitude', lat.toFixed(5));
  u.searchParams.set('types', 'address,street,place,locality');
  u.searchParams.set('language', 'en');
  u.searchParams.set('access_token', token());
  const res = await fetch(u, { signal });
  if (!res.ok) return null;
  return labelFromReverse(await res.json());
}

// ---- Ride Mode's clock ----

const MAX_COORDS = 25; // Directions' per-request limit; windows share their boundary stop

/**
 * Traffic-aware time over the remaining stops — the time ONLY, never the road
 * (routing.js trafficEta). Unpaced seconds and miles, or throws.
 */
export async function mapboxTrafficEta(pos, waypoints, { signal } = {}) {
  const pts = [pos, ...waypoints].filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng));
  if (pts.length < 2) throw new Error('no destination');
  let seconds = 0;
  let meters = 0;
  for (let s = 0; s < pts.length - 1; s += MAX_COORDS - 1) {
    const win = pts.slice(s, s + MAX_COORDS);
    const u = new URL(`${API}/directions/v5/mapbox/driving-traffic/${win.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';')}`);
    u.searchParams.set('overview', 'false');
    u.searchParams.set('steps', 'false');
    // the bike's heading constrains the departure only, as in the other routers
    if (s === 0 && Number.isFinite(pos.heading)) {
      u.searchParams.set('bearings', [`${Math.round(((pos.heading % 360) + 360) % 360)},45`, ...win.slice(1).map(() => '')].join(';'));
    }
    u.searchParams.set('access_token', token());
    const res = await fetch(u, { signal });
    if (!res.ok) throw new Error(`mapbox directions ${res.status}`);
    const route = (await res.json())?.routes?.[0];
    if (!route) throw new Error('mapbox directions: no route');
    seconds += route.duration ?? 0;
    meters += route.distance ?? 0;
  }
  return { seconds, miles: meters / 1609.34 };
}

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

/**
 * @param {object} o
 * @param {string|null} o.category  one of CATEGORIES[].id, or null for free text
 * @param {string} [o.query]
 * @param {{lat:number,lng:number}} o.near
 * @param {number} [o.radiusMi]
 * @param {Array<[number,number]>} [o.route]  [lng,lat] vertices → along-route mode
 */
export async function searchNearby({ category, query, near, radiusMi = 25, route = null, limit = 8 }) {
  if (Date.now() < skipUntil) throw new Error('nearby backoff');
  let res;
  try {
    res = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, query, near, radiusMi, route, limit }),
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

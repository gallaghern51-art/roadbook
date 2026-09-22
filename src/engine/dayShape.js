// Where a proposed route's days begin and end.
//
// A builder proposal is ONE ordered list of stops, and every lodging stop in
// it ends a day: the evaluator measures each day up to its lodging, the
// builder draws "Day 2" under it, and an instant create splits the trip there.
//
// Owner, Sep 20 2026: "it would have one full day then the next day would
// just have a dinner or lodging". Measured against the live planner the same
// evening, on a 2-day Denver loop and a 3-day Salt Lake → Jackson ride: it
// lists every evening's dinner AFTER the hotel — check in, then walk to dinner,
// which is the order a rider lives it — while its own description reads
// "overnight at the Historic Delaware Hotel, dinner at The Leadville Grill →
// Day 2 …". So each dinner opened the NEXT day: in Jackson, Day 2 was the
// first night's dinner, one overlook and the same hotel again, and the dinner's
// 90 minutes counted against the wrong day's clock.
//
// The prompt now asks for dinner before the lodging, but a prompt is not a
// guarantee, so this puts the evening back where it belongs before anything is
// measured or built. Pure, and idempotent — running it twice changes nothing.

const toRad = (d) => (d * Math.PI) / 180;
function milesBetween(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const located = (p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng));
const pt = (p) => ({ lat: Number(p.lat), lng: Number(p.lng) });

// Dinner after check-in is a walk or a short ride in the same town. Anything
// farther than this after a lodging is somewhere the group rides to the next
// day, whatever meal it is.
export const EVENING_RADIUS_MI = 3;
// An unlabelled restaurant has to be closer than that before it is assumed to
// be the evening's — the words decide the far cases, not a guess.
const UNLABELLED_RADIUS_MI = 1.5;
// The trip "ends" at the lodging's own door: a zero-mile last day.
const DOORSTEP_MI = 0.5;

const MORNING_TYPES = new Set(['breakfast_restaurant', 'brunch_restaurant', 'cafe', 'coffee_shop', 'bakery', 'donut_shop', 'bagel_shop']);

/**
 * The meal a food stop is for — the planner's own word first (its `meal`
 * field, then its tags, name and note), else null. Never a guess from order.
 */
export function mealOf(stop) {
  if (stop?.kind !== 'food') return null;
  if (['breakfast', 'lunch', 'dinner'].includes(stop.meal)) return stop.meal;
  const words = [stop.name, stop.detail, stop.reason, ...(stop.preferenceTags ?? [])].filter(Boolean).join(' ').toLowerCase();
  if (/\b(breakfast|brunch)\b/.test(words)) return 'breakfast';
  if (/\b(dinner|supper)\b/.test(words)) return 'dinner';
  if (/\blunch\b/.test(words)) return 'lunch';
  return null;
}

// Is this food stop, listed next to a lodging, that same evening's meal?
export function isEvening(stop, lodging) {
  if (stop?.kind !== 'food' || !located(stop) || !located(lodging)) return false;
  const away = milesBetween(pt(stop), pt(lodging));
  const meal = mealOf(stop);
  if (meal === 'dinner') return away <= EVENING_RADIUS_MI;
  if (meal) return false; // breakfast or lunch after the hotel is the next day's
  // Unlabelled: a sit-down restaurant a few blocks from the hotel is dinner; a
  // café or breakfast place is the next morning's.
  if (MORNING_TYPES.has(stop.primaryType)) return false;
  return away <= UNLABELLED_RADIUS_MI;
}

/**
 * Put each evening's dinner before the lodging it was listed after, and drop a
 * last stop that sits on the last lodging's doorstep. Returns a new array of
 * the same stop objects; a list with nothing to settle comes back equal.
 */
export function settleEvenings(locations) {
  const out = Array.isArray(locations) ? [...locations] : [];
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i].kind !== 'lodging') continue;
    const lodging = out[i];
    let j = i + 1;
    // the whole evening: dinner, and a dessert or drinks stop after it — but
    // never the trip's last stop, which is where the ride ends, not a meal
    while (j < out.length - 1 && isEvening(out[j], lodging)) j++;
    if (j === i + 1) continue;
    const evening = out.splice(i + 1, j - i - 1);
    out.splice(i, 0, ...evening);
    i += evening.length; // the lodging moved; carry on after it
  }
  // "…overnight at the Wort Hotel" then a separate end in Jackson: the trip
  // ends at the hotel, not on a zero-mile day that rides to its own front door.
  const last = out[out.length - 1];
  const before = out[out.length - 2];
  if (out.length > 2 && before?.kind === 'lodging' && last?.kind === 'end' && located(last) && located(before)
    && milesBetween(pt(last), pt(before)) <= DOORSTEP_MI) {
    out.pop();
  }
  return out;
}

/** How many riding days a proposal covers: one per lodging before the end, plus the last. */
export function dayCountOf(locations) {
  const list = Array.isArray(locations) ? locations : [];
  return 1 + list.slice(1, -1).filter((p) => p?.kind === 'lodging').length;
}

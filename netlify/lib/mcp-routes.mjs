// Routes for the rider's own AI: every road worth offering between two
// points, measured — the same engine the app's route sheet runs
// (src/engine/routeOptions.js: Valhalla motorcycle costing per style, plus
// Valhalla's alternates, merged into one honest list), with the two facts a
// planner adds on top:
//
//   traffic  — Google's clock for the departure the rider named (predicted
//              traffic for a future departure, live traffic for "now").
//              Valhalla owns the ROAD; Google owns the CLOCK. For a two-point
//              ride the quote is pinned to Valhalla's line with pass-through
//              points, so it measures THIS road and not whichever one Google
//              would have picked; with stops in the middle it is the
//              corridor's figure, and says so.
//   tolls    — Valhalla flags a tolled road for free; Google prices the one
//              the rider is looking at, as an estimate, labelled as one.
//
// Nothing here writes anything. A measured set is parked in the option store
// so the rider's next word — "save the touring one" — can become a trip
// without re-sending geometry through the model.

import { routeOptions, ROUTE_STYLES } from '../../src/engine/routeOptions.js';
import { computeRoute, isFutureIso } from './google-routes.mjs';
import { searchPlacesGoogle } from './places-core.mjs';

export const STYLE_IDS = ROUTE_STYLES.map((s) => s.id);

// ---------------------------------------------------------------- input ----

const finite = (n) => Number.isFinite(Number(n));

/**
 * A place the caller named — {lat,lng,name?} or a string ("Red Lodge, MT",
 * "Town Pump, Billings") — as a routable point. Strings go through Places
 * (the app's own verifier, so a saved stop carries its place id), biased to
 * `near` when there is one.
 */
export async function resolvePlace(key, input, { near = null, searchImpl = searchPlacesGoogle } = {}) {
  if (input && typeof input === 'object' && finite(input.lat) && finite(input.lng)) {
    return {
      lat: Number(input.lat), lng: Number(input.lng),
      name: String(input.name || `${Number(input.lat).toFixed(4)}, ${Number(input.lng).toFixed(4)}`),
      ...(input.placeId ? { placeId: String(input.placeId) } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.dwell != null ? { dwell: input.dwell } : {}),
    };
  }
  const text = typeof input === 'string' ? input.trim() : String(input?.name ?? '').trim();
  if (!text) throw new Error('a place needs a name or a lat/lng');
  if (!key) throw new Error(`"${text}" needs coordinates — place search is not configured on this server (GOOGLE_MAPS_API_KEY).`);
  // Google's circle bias tops out at 50,000 m — 150 km came back 400
  // INVALID_ARGUMENT the first time a host named both ends of a ride.
  const hits = await searchImpl(key, text, near, { limit: 1, radiusM: 50_000 });
  const hit = hits?.[0];
  if (!hit) throw new Error(`could not find a place called "${text}"`);
  return {
    lat: hit.lat, lng: hit.lng, name: hit.name, detail: hit.detail, placeId: hit.id, verified: 'google',
    ...(input?.kind ? { kind: input.kind } : {}),
    ...(input?.dwell != null ? { dwell: input.dwell } : {}),
  };
}

// ------------------------------------------------------------- geometry ----

/** Every k-th vertex, ends kept — the picture of a road, not its survey. */
export function thinLine(geometry, max = 300) {
  const g = Array.isArray(geometry) ? geometry : [];
  if (g.length <= max) return g.map(([x, y]) => [round5(x), round5(y)]);
  const step = (g.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(g[Math.round(i * step)]);
  return out.map(([x, y]) => [round5(x), round5(y)]);
}
const round5 = (n) => Math.round(n * 1e5) / 1e5;

/** n points spread along the line, ends excluded — pass-through pins. */
export function sampleVias(geometry, n = 4) {
  const g = Array.isArray(geometry) ? geometry : [];
  if (g.length < 3 || n < 1) return [];
  const out = [];
  for (let i = 1; i <= n; i++) {
    const [lng, lat] = g[Math.round((g.length - 1) * (i / (n + 1)))];
    out.push({ lat: round5(lat), lng: round5(lng) });
  }
  return out;
}

// -------------------------------------------------------------- measure ----

/**
 * @param {object} o
 * @param {object} o.start  resolved place
 * @param {object[]} o.stops resolved places, in order
 * @param {object} o.end    resolved place
 * @param {boolean} [o.avoidTolls]
 * @param {string[]} [o.styles]
 * @param {string} [o.prefer]       the rider's own road character
 * @param {number} [o.pace]         group-pace multiplier (trip.meta.pace)
 * @param {string|null} [o.departureTime] ISO; future → predicted traffic
 * @param {boolean} [o.traffic]     ask Google at all (costs a Pro-SKU call per option)
 * @param {string} [o.googleKey]
 * @param {Function} [o.routeImpl]  test seam for routeOptions
 * @param {Function} [o.googleImpl] test seam for computeRoute
 */
export async function measureOptions({
  start, stops = [], end, avoidTolls = false, styles = STYLE_IDS, prefer = null, pace = 1,
  departureTime = null, traffic = true, googleKey = process.env.GOOGLE_MAPS_API_KEY,
  routeImpl = routeOptions, googleImpl = computeRoute, signal,
}) {
  const notes = [];
  const options = await routeImpl({ start, stops, end, avoidTolls, styles, prefer, pace, signal });
  if (!options.length) throw new Error('no road could be measured between these points');

  const future = isFutureIso(departureTime);
  if (departureTime && !future) notes.push('The departure time is in the past, so traffic was measured for right now.');
  const at = future ? departureTime : null;

  const askGoogle = traffic && googleKey;
  if (traffic && !googleKey) notes.push('Traffic and toll prices are not available on this server (no Google key); times are free-flowing road times.');

  const measured = await Promise.all(options.map(async (o) => {
    const base = {
      id: o.id,
      label: o.label,
      style: o.style,
      styles: o.styles,
      kind: o.kind,
      miles: round1(o.miles),
      minutes: Math.round(o.minutes),
      hasToll: !!o.hasToll,
      via: o.via || null,
      fastest: !!o.fastest,
      shortest: !!o.shortest,
      deltaMinutes: Math.round(o.deltaMinutes),
      deltaMiles: round1(o.deltaMiles),
      prefs: o.prefs,
      geometry: thinLine(o.geometry, 300),
      vias: sampleVias(o.geometry, 6),
      traffic: null,
      toll: null,
    };
    if (!askGoogle) return base;
    try {
      // Pin the quote to THIS road when there is nothing else on it; with
      // stops in the middle Google chooses between them, so the figure is
      // the corridor's rather than the line's.
      const pinned = stops.length === 0;
      const waypoints = pinned
        ? [...sampleVias(o.geometry, 4).map((p) => ({ ...p, via: true })), end]
        : [...stops, end];
      const g = await googleImpl(googleKey, { origin: start, waypoints, avoidTolls, tolls: true, ...(at ? { departureTime: at } : {}) });
      const minutes = Math.round((g.durationSeconds / 60) * (pace || 1));
      return {
        ...base,
        traffic: { minutes, miles: round1(g.distanceMeters / 1609.34), at, pinned, deltaMinutes: minutes - base.minutes },
        toll: g.toll ?? null,
      };
    } catch (e) {
      notes.push(`Traffic for "${o.label}" could not be measured (${String(e.message).slice(0, 80)}).`);
      return base;
    }
  }));

  return { options: measured, notes, at };
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** A departure "Saturday 9 AM" style ISO from parts, or null. */
export function parseClock(time) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(String(time ?? '9:00 AM').trim());
  let hour = m ? Number(m[1]) : 9;
  const min = m ? Number(m[2]) : 0;
  if (m?.[3]) {
    const pm = /PM/i.test(m[3]);
    if (pm && hour !== 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  return { hour, min };
}

export function departureIso(date, time, utcOffset = null) {
  if (!date) return null;
  const { hour, min } = parseClock(time);
  const [y, mo, d] = String(date).split('-').map(Number);
  if (![y, mo, d].every(Number.isFinite)) return null;
  const off = utcOffset != null && utcOffset !== '' && Number.isFinite(Number(utcOffset)) ? Number(utcOffset) : 0;
  return new Date(Date.UTC(y, mo - 1, d, hour - off, min)).toISOString();
}

// ------------------------------------------------------- local time ----
//
// "9:00 AM" is the rider's clock at the START of the ride. Read as UTC it
// became 3 AM in Red Lodge, and the predicted traffic was for a road nobody
// was on (caught live through the Claude connector). Google's Time Zone API
// names the zone exactly when the key has it enabled; otherwise a US-band
// estimate, resolved through Intl so daylight saving is right for the date.

/** The zone a US coordinate most likely keeps — a fallback, not a survey. */
export function guessZone(lat, lng) {
  if (lat > 50 && lng < -129) return 'America/Anchorage';
  if (lat < 23 && lng < -154) return 'Pacific/Honolulu';
  if (lng >= -85) return 'America/New_York';
  if (lng >= -102) return 'America/Chicago';
  if (lng >= -114) return (lat > 31 && lat < 37.2 && lng < -109) ? 'America/Phoenix' : 'America/Denver';
  return 'America/Los_Angeles';
}

function offsetAt(zone, ms) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round(((local - ms) / 3600e3) * 4) / 4;
}

/** Hours from UTC that `zone` keeps at the given LOCAL wall time. */
export function zoneOffsetHours(zone, y, mo, d, hour, min) {
  const asUtc = Date.UTC(y, mo - 1, d, hour, min);
  const first = offsetAt(zone, asUtc);
  return offsetAt(zone, asUtc - first * 3600e3);
}

export async function googleTimeZone(key, { lat, lng }, timestampSec, { fetchImpl = fetch } = {}) {
  const url = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${Math.floor(timestampSec)}&key=${encodeURIComponent(key)}`;
  const res = await fetchImpl(url);
  const j = await res.json();
  if (j?.status !== 'OK' || !j.timeZoneId) throw new Error(j?.status || 'no zone');
  return { zone: j.timeZoneId };
}

/**
 * The departure instant for "date + time" said at `place`.
 * → { iso, offset, zone, source: 'given' | 'google' | 'estimate' | 'utc' }
 */
export async function localDeparture(place, date, time, { utcOffset = null, key = '', tzImpl = googleTimeZone } = {}) {
  if (!date) return null;
  const { hour, min } = parseClock(time);
  const [y, mo, d] = String(date).split('-').map(Number);
  if (![y, mo, d].every(Number.isFinite)) return null;
  if (utcOffset != null && utcOffset !== '' && Number.isFinite(Number(utcOffset))) {
    const off = Number(utcOffset);
    return { iso: departureIso(date, time, off), offset: off, zone: null, source: 'given' };
  }
  let zone = null;
  let source = 'utc';
  const at = place && Number.isFinite(place.lat) && Number.isFinite(place.lng) ? place : null;
  if (at && key && tzImpl) {
    try {
      const r = await tzImpl(key, at, Date.UTC(y, mo - 1, d, hour, min) / 1000);
      if (r?.zone) { zone = r.zone; source = 'google'; }
    } catch { /* not enabled on this key, or unreachable — estimate below */ }
  }
  if (!zone && at) { zone = guessZone(at.lat, at.lng); source = 'estimate'; }
  const offset = zone ? zoneOffsetHours(zone, y, mo, d, hour, min) : 0;
  return { iso: departureIso(date, time, offset), offset, zone, source };
}

export const offsetLabel = (off) => `UTC${off >= 0 ? '+' : '−'}${Math.abs(off)}`;

/** One line per option, the way a rider would say it. */
export function describeOptions(set, { options, at, notes }) {
  const lines = options.map((o) => {
    const bits = [`${o.label}${o.via ? ` via ${o.via}` : ''}: ${o.miles} mi, ${fmt(o.minutes)} on the road`];
    if (o.traffic) bits.push(`${fmt(o.traffic.minutes)} in ${at ? 'predicted' : 'current'} traffic${o.traffic.pinned ? '' : ' (corridor estimate)'}`);
    if (o.toll) bits.push(`tolls ≈ ${o.toll.currency} ${o.toll.amount.toFixed(2)}`);
    else if (o.hasToll) bits.push('has tolls');
    const tags = [o.fastest ? 'fastest' : null, o.shortest ? 'shortest' : null].filter(Boolean);
    if (tags.length) bits.push(tags.join(', '));
    return `• [${o.id}] ${bits.join(' · ')}`;
  });
  const head = `${set.start.name} → ${set.stops.length ? `${set.stops.map((s) => s.name).join(' → ')} → ` : ''}${set.end.name}${at ? `, leaving ${at}` : ''}${set.avoidTolls ? ', avoiding tolls' : ''}`;
  return [head, ...lines, ...notes.map((n) => `Note: ${n}`)].join('\n');
}

const fmt = (m) => {
  const n = Math.round(Number(m) || 0);
  const h = Math.floor(n / 60);
  return h ? `${h}h ${String(n % 60).padStart(2, '0')}m` : `${n}m`;
};

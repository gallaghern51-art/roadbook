// Quick Ride: "take me there, the fun way" — a one-day trip made in one tap.
//
// The front door for a rider who is not planning anything: pick a destination
// from where you are, choose the road character, ride. It is deliberately a
// REAL trip under the hood (meta.quick), not a separate nav mode — so Ride
// Mode, reroutes, the fuel chip, the picker, templates, sharing and backup all
// work on it unchanged, and it can be promoted to a full trip later. The one
// thing Google Maps cannot offer on this screen is the Roads choice; it is the
// first thing the rider sees.

import { uid } from './ops.js';
import { cascadeDates } from './dates.js';

export const isQuickTrip = (trip) => !!trip?.meta?.quick;
export const isQuickRec = (rec) => isQuickTrip(rec?.trip);

const today = () => new Date().toISOString().slice(0, 10);
const nowClock = () => {
  const d = new Date();
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
};

/**
 * @param {object} o
 * @param {{lat:number,lng:number,name?:string}} o.start   the bike (or home)
 * @param {{lat:number,lng:number,name:string,detail?:string,id?:string,source?:string}[]} [o.stops]
 *        stops added on the route sheet before Go, in order
 * @param {{lat:number,lng:number,name:string,detail?:string,id?:string,source?:string}} o.dest
 * @param {{style:string,avoidTolls:boolean}} o.routePrefs
 * @param {object} [o.defaults]  tripDefaults(profile): riders, pace, range…
 */
// a place from the card (source google + id) or a From pick (placeId) — either end can be a listing
const placeIdOf = (p) => p?.placeId ?? (p?.source === 'google' && p?.id ? p.id : null);
// identity or intent, never both, and never invented: a listing carries its
// place id, a spot the rider put on the map carries that it was placed
const identity = (p) => (placeIdOf(p)
  ? { placeId: placeIdOf(p), verified: 'google' }
  : p?.placed ? { placed: p.placed } : {});
export function buildQuickTrip({ start, stops = [], dest, routePrefs, defaults = {} }) {
  const title = `Ride to ${dest.name}`;
  const trip = {
    meta: {
      title,
      subtitle: 'Quick ride',
      summary: '',
      quick: true,
      startDate: today(),
      riders: Math.max(1, Number(defaults.riders) || 1),
      nights: 0,
      routePrefs: { style: routePrefs?.style ?? 'touring', avoidTolls: !!routePrefs?.avoidTolls },
      ...(defaults.pace ? { pace: defaults.pace } : {}),
      ...(defaults.range ? { range: defaults.range } : {}),
      roster: [],
    },
    days: [{
      id: uid('day'),
      dow: '', date: '', title, phase: 'outbound',
      miles: 0, hours: 0, depart: nowClock(), arrive: '', anchor: false,
      summary: '', constraints: [], gates: [], meals: [], photos: [], modules: [], ops: [],
      lodging: { status: 'none', name: '', where: '', note: '' },
      waypoints: [
        {
          id: uid('wp'), kind: 'start', name: start.name || 'Current location', lat: start.lat, lng: start.lng, mile: null, note: '',
          ...identity(start),
        },
        // stops added on the route sheet, in the order the rider put them
        ...stops.filter((w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lng)).map((w) => ({
          id: uid('wp'),
          kind: w.kind === 'fuel' ? 'fuel' : w.kind === 'photo' ? 'photo' : 'via',
          ...(w.kind === 'fuel' ? { fuel: true } : {}),
          name: w.name, lat: w.lat, lng: w.lng, mile: null, note: w.detail ?? '',
          ...identity(w),
        })),
        {
          id: uid('wp'), kind: 'end', name: dest.name, lat: dest.lat, lng: dest.lng, mile: null, note: dest.detail ?? '',
          ...identity(dest),
        },
      ],
    }],
  };
  return cascadeDates(trip);
}

/** Promote a quick ride to an ordinary trip: drop the flag, keep everything. */
export function promoteQuickTrip(trip) {
  const t = structuredClone(trip);
  delete t.meta.quick;
  t.meta.subtitle = '';
  return t;
}

/** One GPS fix, as a promise; rejects on denial or timeout. */
export function locateOnce({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('no geolocation')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

// The rider's library, as the MCP server sees it: the same user_trips rows
// the app backs up to (src/engine/cloudLibrary.js), read and written with the
// same row shape, so a trip a rider's own AI saves here is on their phone the
// next time the app pulls — nothing is copied, translated or re-modelled.
//
// Trip documents are built with the app's own engine modules (ops.js ids,
// dates.js cascade, the same day/waypoint fields quickRide.js writes), so the
// planner, the timeline, Ride Mode and the exporters all read them unchanged.

import { uid, blankDay, applyOps, describeOps } from '../../src/engine/ops.js';
import { cascadeDates } from '../../src/engine/dates.js';
import { haversineMiles, normalizeRoutePrefs, DEFAULT_RANGE } from '../../src/engine/tripEngine.js';

const TABLE = 'user_trips';
const SELECT = 'trip_id, name, trip, scenarios, chat, remote, deleted_at, updated_at';

export const APP_URL = (process.env.ROADBOOK_APP_URL || 'https://roadbook-app.netlify.app').replace(/\/$/, '');
export const tripUrl = (tripId) => `${APP_URL}/#trip=${encodeURIComponent(tripId)}`;

const isLibraryTrip = (row) => !row.deleted_at && !row.trip?.meta?.template;

// ---------------------------------------------------------------- rows ----

export async function listTrips(db, userId) {
  const { data, error } = await db.from(TABLE).select(SELECT).eq('user_id', userId).is('deleted_at', null).order('updated_at', { ascending: false });
  if (error) throw new Error(`library read failed: ${error.message}`);
  return (data ?? []).filter(isLibraryTrip);
}

export async function getTripRow(db, userId, tripId) {
  const { data, error } = await db.from(TABLE).select(SELECT).eq('user_id', userId).eq('trip_id', tripId).maybeSingle();
  if (error) throw new Error(`library read failed: ${error.message}`);
  if (!data || data.deleted_at) return null;
  return data;
}

/** Insert or overwrite one record — last write wins, exactly as the app merges. */
export async function saveTrip(db, userId, { tripId, name, trip, scenarios = [], chat = [], remote = null }) {
  const row = {
    user_id: userId,
    trip_id: tripId,
    name: name ?? trip?.meta?.title ?? 'Untitled trip',
    trip,
    scenarios,
    chat: chat.slice(-60),
    remote,
    deleted_at: null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from(TABLE).upsert(row, { onConflict: 'user_id,trip_id' });
  if (error) throw new Error(`library write failed: ${error.message}`);
  return row;
}

/** The app's own delete is a tombstone, so a phone that edited later still wins. */
export async function tombstoneTrip(db, userId, tripId) {
  const { data, error } = await db.from(TABLE)
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('user_id', userId).eq('trip_id', tripId).is('deleted_at', null)
    .select('trip_id');
  if (error) throw new Error(`library write failed: ${error.message}`);
  return (data ?? []).length > 0;
}

// ------------------------------------------------------------ documents ----

const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const KINDS = new Set(['start', 'via', 'fuel', 'photo', 'end']);

// identity or intent, never both, and never invented: a listing carries its
// place id, a spot somebody put on the map carries that it was placed
const identity = (p) => (p?.placeId
  ? { placeId: String(p.placeId), verified: 'google' }
  : p?.placed ? { placed: String(p.placed) } : {});

export function waypointFrom(p, kind) {
  const k = KINDS.has(kind) ? kind : KINDS.has(p?.kind) ? p.kind : 'via';
  return {
    id: uid('wp'),
    kind: k,
    ...(k === 'fuel' || p?.fuel ? { fuel: true } : {}),
    name: String(p?.name || (k === 'start' ? 'Start' : k === 'end' ? 'Destination' : 'Stop')),
    lat: Number(p.lat), lng: Number(p.lng),
    mile: null,
    note: String(p?.note ?? p?.detail ?? ''),
    ...(Number.isFinite(Number(p?.dwell)) ? { dwell: Number(p.dwell) } : {}),
    ...identity(p),
  };
}

function baseMeta({ title, subtitle = '', summary = '', startDate, riders, routePrefs, pace, range, phaseLabels }) {
  return {
    title: String(title || 'Untitled trip'),
    subtitle,
    summary: String(summary || ''),
    startDate: startDate || today(),
    riders: Math.max(1, num(riders, 1)),
    nights: 0,
    routePrefs: normalizeRoutePrefs(routePrefs),
    ...(Number.isFinite(Number(pace)) && Number(pace) > 0 ? { pace: Number(pace) } : {}),
    ...(range && typeof range === 'object' ? { range: { ...DEFAULT_RANGE, ...Object.fromEntries(Object.entries(range).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])) } } : {}),
    ...(phaseLabels && typeof phaseLabels === 'object' ? { phaseLabels } : {}),
    roster: [],
    // where the document came from — the app treats it like any other trip;
    // this is for the rider (and support) to know a connector wrote it
    origin: 'mcp',
  };
}

/**
 * One measured route option → a one-day trip. The route character the option
 * was measured under is written onto the trip, so the app re-routes it the
 * same way; an ALTERNATE road (one Valhalla only offered, no style asks for
 * it) is pinned with a few pass-through `via` points sampled along it, which
 * is exactly how the app's own drag-the-line gesture pins a road.
 */
export function tripFromOption(set, option, { name, date, depart, riders, pace, range } = {}) {
  const startName = set.start?.name || 'Start';
  const endName = set.end?.name || 'Destination';
  const title = name || `${startName} → ${endName}`;
  const day = blankDay({
    title,
    depart: depart || '9:00 AM',
    summary: `${option.label}${option.via ? ` via ${option.via}` : ''} · ${Math.round(option.miles)} mi · ${fmtMin(option.minutes)} on the road.`,
    waypoints: [
      waypointFrom(set.start, 'start'),
      ...interleave(set.stops ?? [], option.kind === 'alternate' ? (option.vias ?? []) : [], option.geometry),
      waypointFrom(set.end, 'end'),
    ],
  });
  const trip = {
    meta: baseMeta({ title, startDate: date, riders, routePrefs: option.prefs, pace, range, summary: `${startName} to ${endName}, ${option.label.toLowerCase()} road.` }),
    days: [day],
  };
  return cascadeDates(trip);
}

// Stops and pinning vias both live on the road; put them in road order.
function interleave(stops, vias, geometry) {
  const along = alongIndex(geometry);
  const rows = [
    ...stops.map((s) => ({ p: s, at: along(s), kind: s.kind === 'fuel' ? 'fuel' : s.kind === 'photo' ? 'photo' : 'via' })),
    ...vias.map((v, i) => ({ p: { ...v, name: `Via ${i + 1}`, placed: 'ai' }, at: along(v), kind: 'via' })),
  ].sort((a, b) => a.at - b.at);
  return rows.map((r) => waypointFrom(r.p, r.kind));
}

// Fraction of the line at which a point sits (nearest vertex — these are
// road points already, so nearest is right).
function alongIndex(geometry) {
  const g = Array.isArray(geometry) ? geometry : [];
  return (p) => {
    if (!g.length || !Number.isFinite(p?.lat)) return 0;
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < g.length; i++) {
      const d = (g[i][1] - p.lat) ** 2 + ((g[i][0] - p.lng) * Math.cos((p.lat * Math.PI) / 180)) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best / Math.max(1, g.length - 1);
  };
}

/**
 * A whole authored itinerary → a trip document. `days[]` is what a planning
 * model naturally writes: title, depart, waypoints in road order, lodging,
 * meals. Endpoint kinds are normalised (first = start, last = end) the way
 * NewTripModal does for the app's own planner.
 */
export function tripFromDays({ name, startDate, days, routePrefs, riders, pace, range, summary, phaseLabels }) {
  const built = (days ?? []).map((d, i) => {
    const wps = (d.waypoints ?? []).filter((w) => Number.isFinite(Number(w?.lat)) && Number.isFinite(Number(w?.lng)));
    const list = wps.map((w, j) => waypointFrom(w, j === 0 ? 'start' : j === wps.length - 1 ? 'end' : (w.kind === 'start' || w.kind === 'end') ? 'via' : w.kind));
    const lodging = d.lodging && typeof d.lodging === 'object'
      ? { status: ['booked', 'reserve', 'none'].includes(d.lodging.status) ? d.lodging.status : 'reserve', name: String(d.lodging.name ?? ''), where: String(d.lodging.where ?? ''), note: String(d.lodging.note ?? ''), ...(d.lodging.placeId ? { placeId: String(d.lodging.placeId) } : {}) }
      : { status: 'none', name: '', where: '', note: '' };
    const meals = (d.meals ?? []).filter((m) => ['breakfast', 'lunch', 'dinner'].includes(m?.meal) && m?.name)
      .map((m) => ({ meal: m.meal, name: String(m.name), where: String(m.where ?? ''), note: String(m.note ?? ''), ...(m.placeId ? { placeId: String(m.placeId) } : {}) }));
    const gates = (d.gates ?? []).filter((g) => g?.label && g?.by).map((g) => {
      const idx = Number.isInteger(g.waypointIndex) ? g.waypointIndex : null;
      return { label: String(g.label), by: String(g.by), ...(idx != null && list[idx] ? { waypointId: list[idx].id } : {}) };
    });
    return blankDay({
      title: String(d.title || `Day ${i + 1}`),
      phase: ['prep', 'outbound', 'rally', 'return'].includes(d.phase) ? d.phase : 'outbound',
      depart: String(d.depart || '9:00 AM'),
      summary: String(d.summary ?? ''),
      waypoints: list,
      lodging,
      meals,
      gates,
    });
  });
  const trip = {
    meta: baseMeta({ title: name, startDate, riders, routePrefs, pace, range, summary, phaseLabels }),
    days: built,
  };
  return cascadeDates(trip);
}

// ------------------------------------------------------------- readback ----

export const fmtMin = (m) => {
  const n = Math.round(Number(m) || 0);
  const h = Math.floor(n / 60);
  const mm = n % 60;
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};

const straightMiles = (wps) => {
  let mi = 0;
  for (let i = 1; i < wps.length; i++) mi += haversineMiles(wps[i - 1], wps[i]);
  return mi;
};

/** A compact, model-readable picture of a trip — no geometry, no prose walls. */
export function tripSummary(row, { measured = null } = {}) {
  const trip = row.trip ?? row;
  const days = (trip.days ?? []).map((d) => {
    const wps = (d.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
    const m = measured?.[d.id];
    return {
      id: d.id,
      date: d.date || null,
      dow: d.dow || null,
      title: d.title,
      phase: d.phase,
      depart: d.depart,
      stops: wps.length,
      from: wps[0]?.name ?? null,
      to: wps[wps.length - 1]?.name ?? null,
      // routed when the app opens the day; here the straight-line figure is
      // labelled as such so a model never quotes it as road miles
      straightLineMiles: Math.round(straightMiles(wps)),
      ...(m ? { roadMiles: Math.round(m.miles), ridingMinutes: Math.round(m.minutes) } : {}),
      unverified: wps.filter((w) => w.verified === false).map((w) => w.name),
      placed: wps.filter((w) => w.placed).map((w) => w.name),
      lodging: d.lodging?.status && d.lodging.status !== 'none' ? `${d.lodging.name || d.lodging.where} (${d.lodging.status})` : null,
      gates: (d.gates ?? []).map((g) => `${g.label} by ${g.by}`),
    };
  });
  const last = days[days.length - 1];
  return {
    tripId: row.trip_id ?? null,
    name: row.name ?? trip.meta?.title,
    title: trip.meta?.title,
    summary: trip.meta?.summary || '',
    startDate: trip.meta?.startDate || null,
    endDate: last?.date ?? null,
    days: days.length,
    riders: trip.meta?.riders ?? 1,
    routePrefs: normalizeRoutePrefs(trip.meta?.routePrefs),
    quick: !!trip.meta?.quick,
    updatedAt: row.updated_at ?? null,
    url: row.trip_id ? tripUrl(row.trip_id) : null,
    dayList: days,
    ...(measured ? { totalRoadMiles: Math.round(Object.values(measured).reduce((s, m) => s + (m?.miles || 0), 0)) } : {}),
  };
}

/** Every stop, for a model that needs ids to write ops against. */
export function tripStops(trip) {
  return (trip.days ?? []).map((d) => ({
    dayId: d.id,
    date: d.date,
    title: d.title,
    waypoints: (d.waypoints ?? []).map((w, i) => ({
      index: i, id: w.id, kind: w.kind, name: w.name, lat: w.lat, lng: w.lng,
      ...(w.fuel ? { fuel: true } : {}),
      ...(w.dwell != null ? { dwell: w.dwell } : {}),
      ...(w.placeId ? { placeId: w.placeId } : {}),
      ...(w.verified !== undefined ? { verified: w.verified } : {}),
      ...(w.placed ? { placed: w.placed } : {}),
      ...(w.note ? { note: w.note } : {}),
    })),
    meals: (d.meals ?? []).map((m) => ({ meal: m.meal, name: m.name, where: m.where ?? '' })),
    lodging: d.lodging ?? null,
    gates: (d.gates ?? []).map((g, i) => ({ index: i, ...g })),
  }));
}

/** Apply the app's op vocabulary; the same reducer path the Copilot uses. */
export function applyTripOps(trip, ops) {
  const withIds = ops.map((op) => {
    if (op.op === 'add_waypoint' && !op.waypoint?.id) return { ...op, waypoint: { ...op.waypoint, id: uid('w') } };
    if (op.op === 'add_day' && !op.day?.id) return { ...op, day: { ...(op.day ?? {}), id: uid('day') } };
    if (op.op === 'add_module' && !op.module?.id) return { ...op, module: { ...op.module, id: uid('mod') } };
    if (op.op === 'add_reservation' && !op.reservation?.id) return { ...op, reservation: { ...op.reservation, id: uid('res') } };
    return op;
  });
  const described = describeOps(trip, withIds);
  const { trip: next, errors } = applyOps(trip, withIds);
  return { trip: next, errors, described };
}

export const newTripId = () => uid('trip');

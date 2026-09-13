// Templates: your own trips, saved as starting points.
//
// The app shipped with exactly ONE template — the bundled Sturgis trip, hard
// coded in src/data/seedTrip.js. That is a template in the sense of "a thing
// you can copy", but it is nobody's own work, and a rider who builds a good
// variant (the early exit out of Red Lodge, say) had no way to keep it as a
// starting point or hand it to a friend.
//
// HOW A TEMPLATE IS STORED, and why it is stored that way: a template is a
// normal library RECORD whose trip carries `meta.template`. It is not a
// separate array and not a separate table, for one decisive reason — the
// account backup (cloudLibrary.js) writes fixed columns per trip and a flag
// living anywhere but INSIDE the trip document would be dropped on the round
// trip, so a template restored on a new phone would come back as a trip. In
// the trip's own meta it rides along for free, through the account backup,
// through JSON export, and through import. Nothing in the schema changes.
//
// Two ways to use one, because the rider asked for both:
//   · a whole new trip from the template          (tripFromTemplate)
//   · some of its days laid INTO an existing trip (daysFromTemplate + the
//     `insert_days` op) — the "use it on top of the Sturgis trip" case
//
// Booking state never travels. A copied trip claiming a confirmed bed nobody
// has booked is the one lie a planning tool must not tell.

import { uid } from './ops.js';
import { cascadeDates } from './dates.js';

export const isTemplateTrip = (trip) => !!trip?.meta?.template;
export const isTemplateRec = (rec) => isTemplateTrip(rec?.trip);

/** The library's real trips — what Home lists and what the trip switcher walks. */
export const libraryTrips = (lib) => (lib?.trips ?? []).filter((r) => !isTemplateRec(r));

/** The rider's saved templates, newest first. */
export const libraryTemplates = (lib) => (lib?.trips ?? [])
  .filter(isTemplateRec)
  .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));

/** A day's booking claims, cleared. Copying a plan never copies a reservation. */
function unbook(day) {
  const d = { ...day };
  if (d.lodging) d.lodging = { ...d.lodging, status: d.lodging.status === 'booked' ? 'reserve' : d.lodging.status };
  if (Array.isArray(d.reservations)) d.reservations = d.reservations.map((r) => ({ ...r, done: false }));
  return d;
}

/** Fresh ids for a day and everything inside it that carries one. */
function reidDay(day) {
  const d = structuredClone(day);
  const map = new Map();
  d.id = uid('day');
  d.waypoints = (d.waypoints ?? []).map((w) => {
    const id = uid('wp');
    map.set(w.id, id);
    return { ...w, id };
  });
  // Gates address a stop by id; a re-id that forgot them would silently drop
  // every deadline on the day (the bug gate-integrity-check.mjs exists for).
  d.gates = (d.gates ?? [])
    .map((g) => (g.waypointId ? { ...g, waypointId: map.get(g.waypointId) ?? g.waypointId } : g))
    .filter((g) => !g.waypointId || [...map.values()].includes(g.waypointId));
  d.modules = (d.modules ?? []).map((m) => ({ ...m, id: m.id ? uid('mod') : m.id }));
  return d;
}

/**
 * Snapshot a working trip as a template. The name is the template's name AND
 * the trip title a copy of it starts with, which is what a rider expects when
 * they name the thing.
 */
export function templateFromTrip(trip, { name, note } = {}) {
  const t = structuredClone(trip);
  t.meta = {
    ...t.meta,
    title: name?.trim() || t.meta?.title || 'Untitled template',
    template: true,
    templateNote: note?.trim() || t.meta?.templateNote || '',
    templateFrom: t.meta?.title ?? '',
    templateAt: new Date().toISOString(),
  };
  t.days = (t.days ?? []).map(unbook);
  return t;
}

/**
 * A new, ordinary trip from a template: fresh ids everywhere, the template
 * flag dropped, dates re-pinned from the new start date.
 */
export function tripFromTemplate(template, { name, startDate } = {}) {
  const src = template?.trip ?? template;
  const t = structuredClone(src);
  t.meta = { ...t.meta, title: name?.trim() || src.meta?.title || 'Untitled trip' };
  if (startDate) t.meta.startDate = startDate;
  delete t.meta.template;
  delete t.meta.templateNote;
  delete t.meta.templateAt;
  t.meta.templateFrom = src.meta?.title ?? '';
  t.days = (t.days ?? []).map((d) => reidDay(unbook(d)));
  return cascadeDates(t);
}

/**
 * Days lifted out of a template, ready to be spliced into another trip. Ids are
 * minted HERE, before the op is built — an op whose ids are minted at apply
 * time diverges per device and breaks every follow-up edit on a shared trip.
 */
export function daysFromTemplate(template, dayIds) {
  const src = template?.trip ?? template;
  const want = dayIds?.length ? new Set(dayIds) : null;
  return (src.days ?? [])
    .filter((d) => !want || want.has(d.id))
    .map((d) => reidDay(unbook(d)));
}

/** The op that lays those days into the current trip. One undoable batch. */
export function insertDaysOp(days, index, label) {
  return { op: 'insert_days', days, index, label };
}

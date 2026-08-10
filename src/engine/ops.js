// Edit operations — the single mutation vocabulary shared by the UI and the AI optimizer.
// Every change to the trip is an op; applyOps is pure (returns a new trip).

import { cascadeDates } from './dates.js';

let counter = 0;
export const uid = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export function blankDay(patch = {}) {
  return {
    id: uid('day'),
    dow: '', date: '',
    title: 'New day', phase: 'outbound',
    miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false,
    summary: '', constraints: [], gates: [],
    waypoints: [], meals: [], photos: [], modules: [], ops: [],
    lodging: { status: 'none', name: '', where: '', note: '' },
    ...patch,
  };
}

export function applyOps(trip, ops) {
  let t = structuredClone(trip);
  const errors = [];
  for (const op of ops) {
    try {
      t = applyOp(t, op);
    } catch (e) {
      errors.push(`${op.op}: ${e.message}`);
    }
  }
  return { trip: t, errors };
}

function findDay(t, dayId) {
  const d = t.days.find((x) => x.id === dayId);
  if (!d) throw new Error(`unknown day ${dayId}`);
  return d;
}

function findModule(day, moduleId) {
  const m = (day.modules ?? []).find((x) => x.id === moduleId);
  if (!m) throw new Error(`unknown module ${moduleId}`);
  return m;
}

// A module with real-world locations puts its stops into the day's route while
// it's switched on. Every op that changes which day owns a module — or whether
// it's on — has to leave day.waypoints consistent with it, so that splice lives
// here rather than being repeated per op.
const moduleWpIds = (m) => (m.waypoints ?? []).map((_, i) => `${m.id}-wp${i}`);

function stripModuleWaypoints(day, m) {
  const ids = moduleWpIds(m);
  if (ids.length) day.waypoints = day.waypoints.filter((w) => !ids.includes(w.id));
}

function insertModuleWaypoints(day, m) {
  if (!m.waypoints?.length) return;
  const ids = moduleWpIds(m);
  // splice before the day's final waypoint so the route runs out and back
  const at = Math.max(1, day.waypoints.length - 1);
  day.waypoints.splice(at, 0, ...m.waypoints.map((mw, i) => ({ id: ids[i], kind: 'via', mile: null, note: '', ...mw })));
}

function applyOp(t, op) {
  switch (op.op) {
    case 'reorder_days': {
      const map = new Map(t.days.map((d) => [d.id, d]));
      if (op.dayIds.length !== t.days.length) throw new Error('dayIds must include every day');
      t.days = op.dayIds.map((id) => {
        const d = map.get(id);
        if (!d) throw new Error(`unknown day ${id}`);
        return d;
      });
      return cascadeDates(t);
    }
    case 'add_day': {
      const day = blankDay(op.day ?? {});
      const at = Math.min(Math.max(op.index ?? t.days.length, 0), t.days.length);
      t.days.splice(at, 0, day);
      return cascadeDates(t);
    }
    case 'remove_day': {
      const idx = t.days.findIndex((d) => d.id === op.dayId);
      if (idx < 0) throw new Error(`unknown day ${op.dayId}`);
      if (t.days.length <= 1) throw new Error('a trip needs at least one day');
      t.days.splice(idx, 1);
      return cascadeDates(t);
    }
    case 'update_lodging': {
      const d = findDay(t, op.dayId);
      d.lodging = { status: 'none', name: '', where: '', note: '', ...d.lodging, ...op.patch };
      return t;
    }
    case 'remove_meal': {
      const d = findDay(t, op.dayId);
      d.meals = (d.meals ?? []).filter((m) => m.meal !== op.meal);
      return t;
    }
    case 'set_meta': {
      // roster: [{ id, name, bike }] — who's riding what, shown under Field notes
      // dusk: "8:30 PM" — after-dark warnings; utcOffset: hours for .ics export
      // pace: riding-duration multiplier (1.0 solo … ~1.15 big group)
      const allowed = ['title', 'subtitle', 'summary', 'riders', 'startDate', 'fuelRule', 'range', 'roster', 'dusk', 'utcOffset', 'pace'];
      for (const k of Object.keys(op.patch ?? {})) {
        if (!allowed.includes(k)) throw new Error(`meta field ${k} not editable`);
      }
      const dateChanged = op.patch.startDate && op.patch.startDate !== t.meta.startDate;
      Object.assign(t.meta, op.patch);
      return dateChanged ? cascadeDates(t) : t;
    }
    case 'reorder_waypoints': {
      const d = findDay(t, op.dayId);
      const map = new Map(d.waypoints.map((w) => [w.id, w]));
      if (op.waypointIds.length !== d.waypoints.length) throw new Error('waypointIds must include every waypoint');
      d.waypoints = op.waypointIds.map((id) => {
        const w = map.get(id);
        if (!w) throw new Error(`unknown waypoint ${id}`);
        return w;
      });
      return t;
    }
    case 'move_waypoint': {
      const from = findDay(t, op.fromDayId);
      const to = findDay(t, op.toDayId);
      const idx = from.waypoints.findIndex((w) => w.id === op.waypointId);
      if (idx < 0) throw new Error(`unknown waypoint ${op.waypointId}`);
      const [w] = from.waypoints.splice(idx, 1);
      const at = Math.min(Math.max(op.index ?? to.waypoints.length, 0), to.waypoints.length);
      to.waypoints.splice(at, 0, w);
      return t;
    }
    case 'add_waypoint': {
      const d = findDay(t, op.dayId);
      const w = { id: uid('w'), kind: 'via', mile: null, note: '', ...op.waypoint };
      if (!Number.isFinite(w.lat) || !Number.isFinite(w.lng)) throw new Error('waypoint needs lat/lng');
      const at = Math.min(Math.max(op.index ?? d.waypoints.length, 0), d.waypoints.length);
      d.waypoints.splice(at, 0, w);
      return t;
    }
    case 'remove_waypoint': {
      const d = findDay(t, op.dayId);
      const idx = d.waypoints.findIndex((w) => w.id === op.waypointId);
      if (idx < 0) throw new Error(`unknown waypoint ${op.waypointId}`);
      d.waypoints.splice(idx, 1);
      return t;
    }
    case 'update_waypoint': {
      const d = findDay(t, op.dayId);
      const w = d.waypoints.find((x) => x.id === op.waypointId);
      if (!w) throw new Error(`unknown waypoint ${op.waypointId}`);
      Object.assign(w, op.patch);
      return t;
    }
    case 'set_day_field': {
      const d = findDay(t, op.dayId);
      const allowed = ['title', 'summary', 'depart', 'arrive', 'phase', 'anchor', 'miles', 'hours'];
      if (!allowed.includes(op.field)) throw new Error(`field ${op.field} not editable`);
      d[op.field] = op.value;
      return t;
    }
    case 'toggle_module': {
      const d = findDay(t, op.dayId);
      const m = findModule(d, op.moduleId);
      m.enabled = op.enabled ?? !m.enabled;
      stripModuleWaypoints(d, m);
      if (m.enabled) insertModuleWaypoints(d, m);
      return t;
    }
    // A module's prose is the trip's reasoning, not decoration — when a stop
    // moves, text that still describes the old slot is worse than no text.
    case 'update_module': {
      const d = findDay(t, op.dayId);
      const m = findModule(d, op.moduleId);
      const allowed = ['name', 'duration', 'why', 'tradeoff', 'logistics'];
      const bad = Object.keys(op.patch ?? {}).filter((k) => !allowed.includes(k));
      if (bad.length) {
        throw new Error(`cannot update ${bad.join(', ')} — use toggle_module, move_module or remove_module`);
      }
      Object.assign(m, op.patch);
      return t;
    }
    case 'move_module': {
      const from = findDay(t, op.fromDayId);
      const to = findDay(t, op.toDayId);
      const idx = (from.modules ?? []).findIndex((x) => x.id === op.moduleId);
      if (idx < 0) throw new Error(`unknown module ${op.moduleId}`);
      const [m] = from.modules.splice(idx, 1);
      stripModuleWaypoints(from, m);
      to.modules = to.modules ?? [];
      to.modules.push(m);
      if (m.enabled) insertModuleWaypoints(to, m);
      return t;
    }
    case 'add_module': {
      const d = findDay(t, op.dayId);
      const m = {
        id: uid('mod'), enabled: false,
        name: '', duration: '', why: '', tradeoff: '', logistics: '',
        ...op.module,
      };
      if (!m.name) throw new Error('module needs a name');
      d.modules = d.modules ?? [];
      d.modules.push(m);
      if (m.enabled) insertModuleWaypoints(d, m);
      return t;
    }
    case 'remove_module': {
      const d = findDay(t, op.dayId);
      const idx = (d.modules ?? []).findIndex((x) => x.id === op.moduleId);
      if (idx < 0) throw new Error(`unknown module ${op.moduleId}`);
      const [m] = d.modules.splice(idx, 1);
      // otherwise its stops linger in the route with no module left to toggle
      stripModuleWaypoints(d, m);
      return t;
    }
    // Gates are the feasibility engine's hardest inputs — a plan is graded
    // against them, so they must be as editable as the stops they time.
    // Addressed by index: gates are short per-day lists with no ids.
    case 'add_gate': {
      const d = findDay(t, op.dayId);
      const g = { label: '', by: '9:00 AM', waypointId: null, ...op.gate };
      if (!g.label) throw new Error('gate needs a label');
      if (g.waypointId && !d.waypoints.some((w) => w.id === g.waypointId)) throw new Error(`unknown waypoint ${g.waypointId}`);
      d.gates = d.gates ?? [];
      d.gates.push(g);
      return t;
    }
    case 'update_gate': {
      const d = findDay(t, op.dayId);
      const g = (d.gates ?? [])[op.index];
      if (!g) throw new Error(`no gate at index ${op.index}`);
      if (op.patch?.waypointId && !d.waypoints.some((w) => w.id === op.patch.waypointId)) throw new Error(`unknown waypoint ${op.patch.waypointId}`);
      Object.assign(g, op.patch);
      return t;
    }
    case 'remove_gate': {
      const d = findDay(t, op.dayId);
      if (!(d.gates ?? [])[op.index]) throw new Error(`no gate at index ${op.index}`);
      d.gates.splice(op.index, 1);
      return t;
    }
    // The booking checklist grew from seed data; a real trip adds and drops
    // bookings as plans firm up.
    case 'add_reservation': {
      const r = { id: uid('res'), name: '', when: '', where: '', note: '', done: false, ...op.reservation };
      if (!r.name) throw new Error('reservation needs a name');
      t.reserveNow = t.reserveNow ?? [];
      t.reserveNow.push(r);
      return t;
    }
    case 'remove_reservation': {
      const idx = (t.reserveNow ?? []).findIndex((x) => x.id === op.reservationId);
      if (idx < 0) throw new Error(`unknown reservation ${op.reservationId}`);
      t.reserveNow.splice(idx, 1);
      return t;
    }
    case 'set_reservation_done': {
      const r = (t.reserveNow ?? []).find((x) => x.id === op.reservationId);
      if (!r) throw new Error(`unknown reservation ${op.reservationId}`);
      r.done = op.done ?? !r.done;
      // Mirror onto lodging status when they correspond. A day with no
      // property name yet must never match — includes('') is true for
      // everything, and ticking any reservation was silently "booking" it.
      for (const d of t.days) {
        const stem = (d.lodging?.name ?? '').split(',')[0].trim().toLowerCase().slice(0, 12);
        if (d.lodging?.status === 'reserve' && stem.length >= 3 && r.name.toLowerCase().includes(stem)) {
          if (op.done) d.lodging.status = 'booked';
        }
      }
      return t;
    }
    case 'update_meal': {
      const d = findDay(t, op.dayId);
      d.meals = d.meals ?? [];
      const m = d.meals.find((x) => x.meal === op.meal);
      if (m) Object.assign(m, op.patch);
      else d.meals.push({ meal: op.meal, name: '', where: '', note: '', alt: '', ...op.patch });
      return t;
    }
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

// Human-readable description of an op list, for the AI proposal preview.
export function describeOps(trip, ops) {
  // Name the leg the way the optimizer is told to name it — never a raw id.
  const dayName = (id) => {
    const d = trip.days.find((x) => x.id === id);
    if (!d) return 'a removed day';
    const title = d.title?.split('·')[0]?.trim() || 'untitled';
    return `${d.dow} ${d.date?.slice(5).replace(/^0?(\d+)-0?(\d+)$/, '$1/$2')} — ${title}`;
  };
  // Modules are named too — “a module” tells the user nothing about what moved.
  const modName = (dayId, moduleId) => {
    const d = trip.days.find((x) => x.id === dayId);
    const m = (d?.modules ?? []).find((x) => x.id === moduleId);
    return m?.name ? `“${m.name}”` : 'a module';
  };
  return ops.map((op) => {
    switch (op.op) {
      case 'reorder_days': return 'Reorder the day sequence';
      case 'reorder_waypoints': return `Reorder stops on ${dayName(op.dayId)}`;
      case 'move_waypoint': return `Move a stop from ${dayName(op.fromDayId)} to ${dayName(op.toDayId)}`;
      case 'add_waypoint': return `Add “${op.waypoint?.name}” to ${dayName(op.dayId)}`;
      case 'remove_waypoint': return `Remove a stop from ${dayName(op.dayId)}`;
      case 'update_waypoint': return `Edit a stop on ${dayName(op.dayId)}`;
      case 'set_day_field': return `Set ${op.field} on ${dayName(op.dayId)}`;
      case 'toggle_module': return `Turn ${op.enabled ? 'ON' : 'OFF'} ${modName(op.dayId, op.moduleId)} on ${dayName(op.dayId)}`;
      case 'update_module': return `Rewrite ${modName(op.dayId, op.moduleId)} (${Object.keys(op.patch ?? {}).join(', ')}) on ${dayName(op.dayId)}`;
      case 'move_module': return `Move ${modName(op.fromDayId, op.moduleId)} from ${dayName(op.fromDayId)} to ${dayName(op.toDayId)}`;
      case 'add_module': return `Add the option “${op.module?.name}” to ${dayName(op.dayId)}`;
      case 'remove_module': return `Remove ${modName(op.dayId, op.moduleId)} from ${dayName(op.dayId)}`;
      case 'set_reservation_done': return 'Update the booking checklist';
      case 'add_gate': return `Add gate “${op.gate?.label}” on ${dayName(op.dayId)}`;
      case 'update_gate': return `Change a gate on ${dayName(op.dayId)}`;
      case 'remove_gate': return `Remove a gate from ${dayName(op.dayId)}`;
      case 'add_reservation': return `Add “${op.reservation?.name}” to the booking checklist`;
      case 'remove_reservation': return 'Remove a booking from the checklist';
      case 'update_meal': return `Change ${op.meal} on ${dayName(op.dayId)}`;
      case 'remove_meal': return `Remove ${op.meal} on ${dayName(op.dayId)}`;
      case 'add_day': return `Add a day${op.day?.title ? ` — “${op.day.title}”` : ''}`;
      case 'remove_day': return `Remove ${dayName(op.dayId)}`;
      case 'update_lodging': return `Change lodging on ${dayName(op.dayId)}`;
      case 'set_meta': return `Update trip settings (${Object.keys(op.patch ?? {}).join(', ')})`;
      default: return op.op;
    }
  });
}

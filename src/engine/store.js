// Trip library store: multiple trips, per-trip scenarios, reducer + localStorage + undo.

import { createContext, useContext } from 'react';
import { SEED_TRIP } from '../data/seedTrip.js';
import { applyOps, uid } from './ops.js';

const LIB_KEY = 'moto.trips.v1';
// pre-library keys (single Sturgis trip) — migrated on first load
const LEGACY_TRIP_KEY = 'sturgis.trip.v2';
const LEGACY_SCEN_KEY = 'sturgis.scenarios.v1';

function freshRecord(trip, name) {
  return {
    id: uid('trip'),
    name: name ?? trip.meta?.title ?? 'Untitled trip',
    trip,
    scenarios: [],
    chat: [],
    // set once the trip is published: { tripId, joinCode }
    remote: null,
    // op batches applied locally but not yet accepted by the server. Persisted,
    // so edits made with no signal are still waiting when the bars come back.
    outbox: [],
    updatedAt: new Date().toISOString(),
  };
}

// One-time data corrections applied to trips already in storage. Fixing the
// seed only helps trips created afterwards, and nobody should have to reset a
// trip to stop seeing a road number that does not exist.
//
// SD-14A: Spearfish Canyon is US-14A. South Dakota has no route 14A, so the
// shield lookup found nothing and the number rendered as plain text.
const DATA_FIXES = [[/\bSD-14A\b/g, 'US-14A']];

function applyDataFixes(lib) {
  let touched = false;
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        let next = v;
        for (const [re, to] of DATA_FIXES) next = next.replace(re, to);
        if (next !== v) { node[k] = next; touched = true; }
      } else walk(v);
    }
  };
  walk(lib.trips);
  if (touched) persistLibrary(lib);
  return lib;
}

export function loadLibrary() {
  try {
    const lib = JSON.parse(localStorage.getItem(LIB_KEY) || 'null');
    if (lib?.trips?.length) return applyDataFixes(lib);
  } catch { /* rebuild below */ }
  // migrate legacy single-trip storage, else seed with the Sturgis template
  let trip = null;
  let scenarios = [];
  try { trip = JSON.parse(localStorage.getItem(LEGACY_TRIP_KEY) || 'null'); } catch { /* seed */ }
  try { scenarios = JSON.parse(localStorage.getItem(LEGACY_SCEN_KEY) || '[]'); } catch { /* none */ }
  const rec = freshRecord(trip?.days?.length ? trip : structuredClone(SEED_TRIP));
  rec.scenarios = Array.isArray(scenarios) ? scenarios : [];
  // Marks a library nobody has touched yet: a fresh install opens on the
  // bundled Sturgis template, and signing in on a new phone should restore
  // YOUR trips rather than adding another copy of the template to the account.
  // Cleared by the first edit of any kind (see syncTrip / touchRecord).
  if (!trip?.days?.length) rec.seeded = true;
  const lib = { trips: [rec], activeId: rec.id };
  persistLibrary(lib);
  return lib;
}

export function persistLibrary(lib) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  } catch { /* storage full — non-fatal */ }
}

function activeRecord(lib) {
  return lib.trips.find((t) => t.id === lib.activeId) ?? lib.trips[0];
}

// Persist bookkeeping that hangs off the record rather than the trip itself.
function syncMeta(state, patch) {
  const rec = activeRecord(state.lib);
  Object.assign(rec, patch);
  persistLibrary(state.lib);
}

// Write the working trip back into its library record and persist.
function syncTrip(state, trip) {
  const lib = state.lib;
  const rec = activeRecord(lib);
  rec.trip = trip;
  rec.name = trip.meta?.title ?? rec.name;
  rec.updatedAt = new Date().toISOString();
  delete rec.seeded;
  persistLibrary(lib);
  return trip;
}

// Scenario writes change the record without going through syncTrip. The cloud
// backup merges by updatedAt, so a permutation saved and never otherwise
// touched has to move the clock too or a stale copy on another device wins.
function touchRecord(state) {
  const rec = activeRecord(state.lib);
  rec.updatedAt = new Date().toISOString();
  delete rec.seeded;
  return rec;
}

export const initialState = () => {
  const lib = loadLibrary();
  const rec = activeRecord(lib);
  return {
    lib,
    trip: rec.trip,
    scenarios: rec.scenarios,
    chat: rec.chat ?? [],
    remote: rec.remote ?? null,
    outbox: rec.outbox ?? [],
    activeScenarioId: rec.activeScenarioId ?? null, // which saved permutation the working plan came from
    history: [], // undo stack of previous trips (capped)
    selectedDayId: null, // null = whole-trip overview
    pendingProposal: null, // { ops, summary, saveAs, overwriteScenarioId }
    modal: null, // { type: 'stop'|'leg', dayId, waypointId?, legIndex? }
    chatAsk: null, // question queued for the optimizer
    opLog: [], // ops since the last collab mark — a rider's unsent proposal
    focusLeg: null, // { dayId, index } — hovered leg, highlighted on the map
  };
};

export function reducer(state, action) {
  switch (action.type) {
    case 'apply_ops': {
      // Add-ops mint their ids HERE, before applying, not inside applyOp:
      // these op objects ship to other devices (sync outbox, collab
      // proposals), and an id minted during replay comes out different on
      // every device — after which each follow-up edit addressed to the
      // author's id silently fails everywhere else.
      const ops = action.remote ? action.ops : action.ops.map((op) => {
        if (op.op === 'add_waypoint' && !op.waypoint?.id) return { ...op, waypoint: { ...op.waypoint, id: uid('w') } };
        if (op.op === 'add_day' && !op.day?.id) return { ...op, day: { ...(op.day ?? {}), id: uid('day') } };
        if (op.op === 'add_module' && !op.module?.id) return { ...op, module: { ...op.module, id: uid('mod') } };
        if (op.op === 'add_reservation' && !op.reservation?.id) return { ...op, reservation: { ...op.reservation, id: uid('res') } };
        return op;
      });
      const { trip, errors } = applyOps(state.trip, ops);
      if (errors.length) console.warn('op errors', errors);
      syncTrip(state, trip);
      // action.remote = this batch arrived FROM the server. Queueing it would
      // bounce it straight back and loop.
      const outbox = action.remote ? state.outbox : [...state.outbox, { id: uid('ob'), ops }];
      if (!action.remote) syncMeta(state, { outbox });
      return {
        ...state, trip, outbox,
        // Undo is a local snapshot stack; restoring one would silently revert a
        // co-rider's edit, so a shared trip does not stack remote changes.
        history: action.remote ? state.history : [state.trip, ...state.history].slice(0, 30),
        // Ops also accumulate for collaborate mode: a rider's edit session
        // becomes the proposal it sends (capped — a runaway session is not a
        // proposal). Server-originated batches are not yours to propose.
        opLog: action.remote ? state.opLog : [...state.opLog, ...ops].slice(-120),
      };
    }
    // the server accepted these batches — drop them from the queue
    case 'outbox_sent': {
      const done = new Set(action.ids);
      const outbox = state.outbox.filter((b) => !done.has(b.id));
      syncMeta(state, { outbox });
      return { ...state, outbox };
    }
    // Adopting a shared trip: the joined copy replaces this device's, and the
    // outbox and op log are dropped — those edits belong to a trip this
    // device just left.
    case 'load_trip': {
      syncTrip(state, action.trip);
      syncMeta(state, { outbox: [] });
      return { ...state, trip: action.trip, outbox: [], opLog: [], history: [], selectedDayId: null };
    }
    case 'set_remote': {
      syncMeta(state, { remote: action.remote });
      return { ...state, remote: action.remote };
    }
    // Collaborate mode: adopt the group's trip without touching undo or the op
    // log — remote updates are not edits the local rider made.
    case 'sync_trip': {
      syncTrip(state, action.trip);
      return { ...state, trip: action.trip };
    }
    case 'collab_mark':
      return { ...state, opLog: [] };
    case 'undo': {
      if (!state.history.length) return state;
      const [prev, ...rest] = state.history;
      syncTrip(state, prev);
      return { ...state, trip: prev, history: rest };
    }
    case 'reset': {
      const trip = structuredClone(SEED_TRIP);
      syncTrip(state, trip);
      return { ...state, trip, history: [state.trip, ...state.history].slice(0, 30) };
    }
    case 'import': {
      syncTrip(state, action.trip);
      return { ...state, trip: action.trip, history: [state.trip, ...state.history].slice(0, 30) };
    }

    // ---- trip library ----
    // Switching records swaps EVERYTHING scoped to the trip — remote binding,
    // outbox, opLog included. Carrying the old trip's remote/outbox across
    // pushed the new trip's edits into the old shared trip's op log (and kept
    // applying the old trip's incoming ops onto the new working copy).
    case 'create_trip': {
      const rec = freshRecord(action.trip, action.name);
      const lib = { ...state.lib, trips: [...state.lib.trips, rec], activeId: rec.id };
      persistLibrary(lib);
      return { ...state, lib, trip: rec.trip, scenarios: rec.scenarios, chat: rec.chat ?? [], remote: rec.remote ?? null, outbox: rec.outbox ?? [], opLog: [], activeScenarioId: rec.activeScenarioId ?? null, history: [], selectedDayId: null, pendingProposal: null, modal: null };
    }
    case 'switch_trip': {
      const lib = { ...state.lib, activeId: action.id };
      const rec = activeRecord(lib);
      persistLibrary(lib);
      return { ...state, lib, trip: rec.trip, scenarios: rec.scenarios, chat: rec.chat ?? [], remote: rec.remote ?? null, outbox: rec.outbox ?? [], opLog: [], activeScenarioId: rec.activeScenarioId ?? null, history: [], selectedDayId: null, pendingProposal: null, modal: null };
    }
    case 'delete_trip': {
      if (state.lib.trips.length <= 1) return state;
      const trips = state.lib.trips.filter((t) => t.id !== action.id);
      const lib = { trips, activeId: state.lib.activeId === action.id ? trips[0].id : state.lib.activeId };
      const rec = activeRecord(lib);
      persistLibrary(lib);
      return { ...state, lib, trip: rec.trip, scenarios: rec.scenarios, chat: rec.chat ?? [], remote: rec.remote ?? null, outbox: rec.outbox ?? [], opLog: [], activeScenarioId: rec.activeScenarioId ?? null, history: [], selectedDayId: null };
    }

    // Restoring the library from the account (src/engine/cloudLibrary.js).
    // `records` are trips the cloud is right about, `remove` are ones deleted on
    // another device. The decision of who is right is made there and this only
    // applies it — the reducer has no business talking to a network.
    case 'merge_library': {
      const remove = new Set(action.remove ?? []);
      const incoming = new Map((action.records ?? []).map((r) => [r.id, r]));
      if (!remove.size && !incoming.size) return state;
      const trips = state.lib.trips
        .filter((r) => !remove.has(r.id))
        .map((r) => {
          const next = incoming.get(r.id);
          if (!next) return r;
          incoming.delete(r.id);
          // The local outbox stays: those are ops this device made and has not
          // yet handed to the crew, and no cloud copy of the trip knows them.
          const merged = { ...r, ...next, outbox: r.outbox ?? [] };
          delete merged.seeded;
          return merged;
        });
      for (const rec of incoming.values()) trips.push(rec);
      // A library with nothing in it has no working trip to show. Better to
      // decline the merge than to leave the app pointing at nothing.
      if (!trips.length) return state;
      const activeId = trips.some((r) => r.id === state.lib.activeId) ? state.lib.activeId : trips[0].id;
      const lib = { ...state.lib, trips, activeId };
      persistLibrary(lib);
      // Adopting OTHER trips must not disturb the one being planned right now.
      const activeTouched = activeId !== state.lib.activeId
        || remove.has(state.lib.activeId)
        || (action.records ?? []).some((r) => r.id === activeId);
      if (!activeTouched) return { ...state, lib };
      const rec = activeRecord(lib);
      return {
        ...state, lib, trip: rec.trip, scenarios: rec.scenarios, chat: rec.chat ?? [],
        remote: rec.remote ?? null, outbox: rec.outbox ?? [], opLog: [],
        activeScenarioId: rec.activeScenarioId ?? null,
        history: [], selectedDayId: null, pendingProposal: null, modal: null,
      };
    }

    // ---- UI ----
    case 'select_day':
      return { ...state, selectedDayId: action.dayId };
    case 'focus_point':
      // `at` makes re-clicking the same stop re-trigger the map effect.
      return { ...state, focus: { lat: action.lat, lng: action.lng, at: Date.now() } };
    case 'focus_leg':
      // Hovering a stop row lights its arriving leg on the map. null clears.
      return { ...state, focusLeg: action.leg ?? null };
    case 'open_modal':
      return { ...state, modal: action.modal };
    case 'close_modal':
      return { ...state, modal: null };
    case 'ask_optimizer':
      return { ...state, chatAsk: action.text };
    case 'clear_chat_ask':
      return { ...state, chatAsk: null };
    case 'set_proposal':
      return { ...state, pendingProposal: action.proposal };
    case 'clear_proposal':
      return { ...state, pendingProposal: null };

    // Chat history persists per trip so the optimizer's memory survives reloads.
    // Translations live ON the trip (trip.i18n[lang]) rather than in source, so
    // they export/import with it and any trip — hand-built or AI-generated — can
    // carry its own. Merged, never replaced: a partial run keeps what it got.
    case 'save_translations': {
      const trip = { ...state.trip, i18n: { ...(state.trip.i18n ?? {}) } };
      trip.i18n[action.lang] = { ...(trip.i18n[action.lang] ?? {}), ...action.translations };
      syncTrip(state, trip);
      return { ...state, trip };
    }
    case 'save_chat': {
      const rec = activeRecord(state.lib);
      rec.chat = action.messages.slice(-60); // cap so localStorage stays sane
      persistLibrary(state.lib);
      return { ...state, chat: rec.chat };
    }
    case 'clear_chat': {
      const rec = activeRecord(state.lib);
      rec.chat = [];
      persistLibrary(state.lib);
      return { ...state, chat: [] };
    }

    // ---- scenarios (scoped to the active trip) ----
    case 'save_scenario': {
      const rec = touchRecord(state);
      const name = action.name || `Scenario ${rec.scenarios.length + 1}`;
      // Idempotent: an identical snapshot under the same name is the same
      // save — guards double-taps (and StrictMode's dev double-invoke).
      const cur = JSON.stringify(state.trip);
      const dup = rec.scenarios.find((s) => s.name === name && JSON.stringify(s.trip) === cur);
      if (dup) {
        rec.activeScenarioId = dup.id;
        persistLibrary(state.lib);
        return { ...state, scenarios: rec.scenarios, activeScenarioId: dup.id };
      }
      const scen = {
        id: uid('s'),
        name,
        savedAt: new Date().toISOString(),
        trip: structuredClone(state.trip),
      };
      rec.scenarios = [...rec.scenarios, scen];
      rec.activeScenarioId = scen.id;
      persistLibrary(state.lib);
      return { ...state, scenarios: rec.scenarios, activeScenarioId: scen.id };
    }
    case 'load_scenario': {
      const rec = activeRecord(state.lib);
      const scen = rec.scenarios.find((s) => s.id === action.id);
      if (!scen) return state;
      // Switching must never be a one-way door: if the working plan matches no
      // saved snapshot, stash it first so there is always a way back to it.
      // Only the LATEST auto-stash survives — a row of "Auto-saved 3:42" chips
      // nobody named is clutter, not safety.
      const cur = JSON.stringify(state.trip);
      if (!rec.scenarios.some((s2) => JSON.stringify(s2.trip) === cur)) {
        const d = new Date();
        rec.scenarios = [...rec.scenarios.filter((s2) => s2.id === scen.id || !/^Auto-saved /.test(s2.name)), {
          id: uid('s'),
          name: `Auto-saved ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`,
          savedAt: d.toISOString(),
          trip: structuredClone(state.trip),
        }];
      }
      const trip = structuredClone(scen.trip);
      rec.activeScenarioId = scen.id;
      syncTrip(state, trip);
      // A group load on a shared trip must REACH the group: the swap ships as
      // a replace_trip op through the same outbox as every other edit, so
      // riders with the app open receive it via realtime. (Compaction alone
      // only rescued riders whose apps were closed — and never propagated at
      // all when a non-owner loaded, since compact() is owner-only by RLS.)
      let outbox = state.outbox;
      if (action.broadcast && state.remote?.tripId) {
        outbox = [...state.outbox, { id: uid('ob'), ops: [{ op: 'replace_trip', label: scen.name, trip: structuredClone(scen.trip) }] }];
        syncMeta(state, { outbox });
      }
      return { ...state, trip, outbox, scenarios: rec.scenarios, activeScenarioId: scen.id, history: [state.trip, ...state.history].slice(0, 30), modal: null };
    }
    case 'delete_scenario': {
      const rec = touchRecord(state);
      rec.scenarios = rec.scenarios.filter((s) => s.id !== action.id);
      if (rec.activeScenarioId === action.id) rec.activeScenarioId = null;
      persistLibrary(state.lib);
      return { ...state, scenarios: rec.scenarios, activeScenarioId: rec.activeScenarioId ?? null };
    }
    case 'overwrite_scenario': {
      const rec = touchRecord(state);
      rec.scenarios = rec.scenarios.map((s) =>
        s.id === action.id ? { ...s, trip: structuredClone(state.trip), savedAt: new Date().toISOString() } : s
      );
      rec.activeScenarioId = action.id; // the working plan now IS this permutation
      persistLibrary(state.lib);
      return { ...state, scenarios: rec.scenarios, activeScenarioId: action.id };
    }
    default:
      return state;
  }
}

export const TripContext = createContext(null);
export const useTrip = () => useContext(TripContext);

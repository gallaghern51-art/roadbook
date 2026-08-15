// The trip library, backed up to the account.
//
// This is the answer to the one failure the app could not survive: localStorage
// is the device's truth, and deleting the PWA (or the phone going in a river
// outside Spearfish) took the whole roadbook with it. Sign in and the library
// has a second home.
//
// It is deliberately NOT the op-log sync in useTripSync.js. That one exists so
// a CREW converges on one shared trip in realtime, and it is per-trip, joined
// by code, with everybody appending to one history. This is per-RIDER: your
// library, your trips, nobody else's, and the only conflict that can arise is
// the same person editing on two devices. So the merge is last-write-wins per
// trip record — coarse, predictable, and never silently half-applied.
//
// Order matters at sign-in: PULL first, merge, then push what the cloud does
// not have. Pushing first on a fresh install would upload an empty library over
// a real one, which is the exact data loss this feature exists to prevent.

import { useEffect, useRef, useState } from 'react';
import { supabase, SYNC_ENABLED } from './supabase.js';

const TABLE = 'user_trips';

// Cheap content fingerprint. Only used to answer "has this record changed since
// I last pushed it" — a hash collision costs one skipped upload, not a wrong
// merge, so 32 bits is plenty and the speed matters on a phone.
function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return String(h);
}

function fingerprint(rec) {
  return hash(JSON.stringify([rec.name, rec.trip, rec.scenarios ?? [], rec.chat ?? []]));
}

const stamp = (rec) => rec.updatedAt || '1970-01-01T00:00:00.000Z';

function rowFor(rec, userId) {
  return {
    user_id: userId,
    trip_id: rec.id,
    name: rec.name ?? rec.trip?.meta?.title ?? 'Untitled trip',
    trip: rec.trip,
    scenarios: rec.scenarios ?? [],
    chat: (rec.chat ?? []).slice(-60),
    remote: rec.remote ?? null,
    deleted_at: null,
    updated_at: stamp(rec),
  };
}

function recFor(row) {
  return {
    id: row.trip_id,
    name: row.name,
    trip: row.trip,
    scenarios: row.scenarios ?? [],
    chat: row.chat ?? [],
    remote: row.remote ?? null,
    outbox: [],
    updatedAt: row.updated_at,
  };
}

/** Everything this account has stored, tombstones included. */
export async function pullLibrary(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('trip_id, name, trip, scenarios, chat, remote, deleted_at, updated_at')
    .eq('user_id', userId);
  if (error) throw error;
  return data ?? [];
}

/**
 * Decide, per trip id, who is right. Pure so it can be reasoned about (and
 * tested) without a network or a reducer.
 *
 * Returns { adopt, drop, push, tombstone } — adopt/drop are for the local
 * library, push/tombstone are for the server.
 */
export function planMerge(localRecs, rows) {
  const remote = new Map(rows.map((r) => [r.trip_id, r]));
  const local = new Map(localRecs.map((r) => [r.id, r]));
  const adopt = [];   // records to write into the local library
  const drop = [];    // local ids to remove (deleted on another device)
  const push = [];    // local records the server needs
  const tombstone = []; // trip ids deleted here, still live on the server

  for (const row of rows) {
    const rec = local.get(row.trip_id);
    if (row.deleted_at) {
      // Deleted elsewhere. A local copy edited SINCE the delete wins — the
      // rider's later work is not something to throw away on a tombstone.
      if (rec && stamp(rec) > row.deleted_at) push.push(rec);
      else if (rec) drop.push(rec.id);
      continue;
    }
    if (!rec) { adopt.push(recFor(row)); continue; }
    if (stamp(rec) > row.updated_at) push.push(rec);
    else if (stamp(rec) < row.updated_at) adopt.push(recFor(row));
  }

  for (const rec of localRecs) {
    if (remote.has(rec.id)) continue;
    // A record the server has never seen. Pristine seed libraries are the one
    // exception: a fresh install starts with the bundled Sturgis template, and
    // uploading that on every new phone litters the account with copies of a
    // trip nobody made. It is dropped instead, once real trips arrive.
    if (rec.seeded && adopt.length) { drop.push(rec.id); continue; }
    push.push(rec);
  }

  return { adopt, drop, push, tombstone };
}

/**
 * Keeps the library mirrored to the account.
 *
 * Off entirely without an account: no rows, no requests, no behavior change.
 * Returns { status, savedAt, error, backupNow } for the UI to report with.
 */
export function useLibraryBackup(state, dispatch, account) {
  const [status, setStatus] = useState('off'); // off | syncing | saved | error
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);
  // trip id -> fingerprint of what the server last accepted. Nothing is
  // uploaded twice, and a chat-only edit still counts as a change.
  const sentRef = useRef(new Map());
  const restoredRef = useRef(null); // which account this device has pulled for
  const busyRef = useRef(false);
  const libRef = useRef(state.lib);
  libRef.current = state.lib;

  const userId = account?.id ?? null;

  const run = useRef(async () => {});
  run.current = async () => {
    if (!SYNC_ENABLED || !userId || busyRef.current) return;
    busyRef.current = true;
    setStatus('syncing');
    setError(null);
    try {
      const first = restoredRef.current !== userId;
      const rows = first ? await pullLibrary(userId) : [];
      const locals = libRef.current.trips;

      if (first) {
        const { adopt, drop, push } = planMerge(locals, rows);
        if (adopt.length || drop.length) {
          dispatch({ type: 'merge_library', records: adopt, remove: drop });
        }
        // The server's copies are, by definition, already on the server.
        for (const row of rows) {
          if (!row.deleted_at && !drop.includes(row.trip_id)) {
            sentRef.current.set(row.trip_id, fingerprint(recFor(row)));
          }
        }
        restoredRef.current = userId;
        if (push.length) {
          const { error: e } = await supabase.from(TABLE).upsert(
            push.map((r) => rowFor(r, userId)), { onConflict: 'user_id,trip_id' },
          );
          if (e) throw e;
          for (const r of push) sentRef.current.set(r.id, fingerprint(r));
        }
      } else {
        // Steady state: upload what changed, tombstone what went away.
        const changed = locals.filter((r) => sentRef.current.get(r.id) !== fingerprint(r));
        if (changed.length) {
          const { error: e } = await supabase.from(TABLE).upsert(
            changed.map((r) => rowFor(r, userId)), { onConflict: 'user_id,trip_id' },
          );
          if (e) throw e;
          for (const r of changed) sentRef.current.set(r.id, fingerprint(r));
        }
        const live = new Set(locals.map((r) => r.id));
        const gone = [...sentRef.current.keys()].filter((id) => !live.has(id));
        if (gone.length) {
          const { error: e } = await supabase.from(TABLE)
            .update({ deleted_at: new Date().toISOString() })
            .eq('user_id', userId)
            .in('trip_id', gone);
          if (e) throw e;
          for (const id of gone) sentRef.current.delete(id);
        }
      }
      setStatus('saved');
      setSavedAt(new Date());
    } catch (e) {
      setStatus('error');
      setError(e?.message ?? String(e));
    } finally {
      busyRef.current = false;
    }
  };

  // Signing out is not a reason to forget anything local — it just stops the
  // mirroring. The next sign-in pulls fresh.
  useEffect(() => {
    if (!userId) {
      restoredRef.current = null;
      sentRef.current = new Map();
      setStatus('off');
      setSavedAt(null);
      setError(null);
    }
  }, [userId]);

  // Restore on sign-in, then follow every library edit. Debounced: a rider
  // dragging a waypoint produces a burst of ops and one upload is enough.
  //
  // Watching state.lib ALONE would never fire for an ordinary edit: the reducer
  // writes the new trip into the existing record and persists it (syncTrip), so
  // the library object keeps its identity and only add/switch/delete/merge
  // replace it. The pieces it does swap are listed instead — between them they
  // cover every write a record can take.
  useEffect(() => {
    if (!SYNC_ENABLED || !userId) return undefined;
    const first = restoredRef.current !== userId;
    const t = setTimeout(() => { run.current(); }, first ? 0 : 2500);
    return () => clearTimeout(t);
  }, [userId, state.lib, state.trip, state.scenarios, state.chat]);

  // Never leave with unsaved work: a tab closing mid-debounce would otherwise
  // drop the last edit until the next launch.
  useEffect(() => {
    if (!SYNC_ENABLED || !userId) return undefined;
    const onHide = () => { if (document.visibilityState === 'hidden') run.current(); };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [userId]);

  return { status, savedAt, error, backupNow: () => run.current(), enabled: SYNC_ENABLED };
}

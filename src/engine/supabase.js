// Supabase client, and the sync primitives built on it.
//
// The app works with no account and no network — localStorage is still the
// source of truth on the device. Sync is additive: when a trip is shared, the
// op log becomes the shared history and every rider replays it. Nothing here
// blocks the UI, and every call fails soft.
//
// Keys: the publishable key ships in the bundle on purpose. Access is enforced
// by row-level security in supabase/schema.sql, not by hiding the string.

import { createClient } from '@supabase/supabase-js';

// `?? {}` so the engine still imports under plain node — the check scripts in
// scripts/ exercise this file's dependents without a bundler, and there
// import.meta.env does not exist at all.
const ENV = import.meta.env ?? {};
const URL = ENV.VITE_SUPABASE_URL || '';
const KEY = ENV.VITE_SUPABASE_KEY || '';

/** Sync is off entirely when the project is not configured. */
export const SYNC_ENABLED = Boolean(URL && KEY);

export const supabase = SYNC_ENABLED
  ? createClient(URL, KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 5 } },
    })
  : null;

// Identifies this browser tab so it can ignore the echo of its own writes —
// they were already applied optimistically before the round trip.
export const CLIENT_ID = (() => {
  const k = 'moto.clientId.v1';
  try {
    let id = localStorage.getItem(k);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(k, id); }
    return id;
  } catch { return crypto.randomUUID(); }
})();

// ---------------------------------------------------------------- auth ----

export async function currentUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

/**
 * Identity, created silently.
 *
 * There is no sign-in screen. The first time a device shares or joins a trip it
 * gets an anonymous session, and from then on the join code is the only thing a
 * human ever handles. A login form is pure friction for a group of riders who
 * already trust each other and already have the code.
 *
 * `name` is what the others see in the roster.
 */
export async function ensureSession(name) {
  if (!supabase) throw new Error('sync not configured');
  const existing = await currentUser();
  if (existing) {
    if (name && existing.user_metadata?.name !== name) {
      await supabase.auth.updateUser({ data: { name } });
    }
    return existing;
  }
  const { data, error } = await supabase.auth.signInAnonymously({
    options: { data: { name: name || null } },
  });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

// -------------------------------------------------------------- trips ----

/** Publish a local trip so the group can join it. Returns { id, joinCode }. */
export async function publishTrip(trip, name, riderName) {
  const user = await ensureSession(riderName);
  const { data, error } = await supabase
    .from('trips')
    .insert({ name, snapshot: trip, owner: user.id })
    .select('id, join_code')
    .single();
  if (error) throw error;
  // The owner is a member too, or their own RLS policies lock them out of ops.
  await supabase.from('trip_members').insert({ trip_id: data.id, user_id: user.id });
  return { id: data.id, joinCode: data.join_code };
}

/** Join by the code the owner texts round. Returns the trip id. */
export async function joinTrip(code, riderName) {
  await ensureSession(riderName);
  const { data, error } = await supabase.rpc('join_trip', {
    code: code.trim(),
    rider_name: riderName ?? null,
  });
  if (error) throw error;
  return data;
}

/** Who is on this trip, for the roster. */
export async function fetchMembers(tripId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('trip_members')
    .select('user_id, name, joined_at')
    .eq('trip_id', tripId)
    .order('joined_at', { ascending: true });
  if (error) return [];
  return data ?? [];
}

/** Snapshot + every op after it — the state a phone joins into. */
export async function fetchTrip(tripId) {
  const { data: row, error } = await supabase
    .from('trips')
    .select('id, name, snapshot, snapshot_seq, join_code')
    .eq('id', tripId)
    .single();
  if (error) throw error;
  const { data: ops, error: opsErr } = await supabase
    .from('trip_ops')
    .select('seq, ops, author, client_id')
    .eq('trip_id', tripId)
    .gt('seq', row.snapshot_seq)
    .order('seq', { ascending: true });
  if (opsErr) throw opsErr;
  return { row, ops: ops ?? [] };
}

// ---------------------------------------------------------------- ops ----

/** Append one batch of ops. Throws so the caller can re-queue it. */
export async function pushOps(tripId, ops) {
  const user = await currentUser();
  if (!user) throw new Error('no session');
  const { data, error } = await supabase
    .from('trip_ops')
    .insert({ trip_id: tripId, ops, author: user.id, client_id: CLIENT_ID })
    .select('seq')
    .single();
  if (error) throw error;
  return data.seq;
}

/**
 * Live feed of other riders' ops. `onOps({ seq, ops })` fires per insert; this
 * client's own echoes are dropped, having been applied optimistically already.
 * Returns an unsubscribe function.
 */
export function subscribeOps(tripId, onOps) {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`trip_ops:${tripId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trip_ops', filter: `trip_id=eq.${tripId}` },
      (payload) => {
        const row = payload.new;
        if (row.client_id === CLIENT_ID) return;
        onOps({ seq: row.seq, ops: row.ops });
      },
    )
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/**
 * Fold the log back into the snapshot. Without this, a rider joining late
 * replays the entire trip's edit history on a phone. Owner-only by RLS.
 */
export async function compact(tripId, trip, seq) {
  if (!supabase) return;
  await supabase
    .from('trips')
    .update({ snapshot: trip, snapshot_seq: seq, updated_at: new Date().toISOString() })
    .eq('id', tripId);
}

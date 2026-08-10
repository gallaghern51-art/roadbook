import { useEffect, useRef, useState } from 'react';
import { SYNC_ENABLED, supabase, subscribeOps, pushOps, fetchTrip, compact, currentUser, CLIENT_ID } from './supabase.js';
import { applyOps } from './ops.js';

// Keeps a published trip in step with everyone else on it.
//
// Two directions, both riding on the op log the app already produces:
//
//   out  the reducer queues every local op batch in `outbox`. This drains it,
//        oldest first, and only clears a batch the server has accepted. The
//        queue is persisted, so edits made in a canyon with no bars go up when
//        the bars come back — the app is offline-first and stays that way.
//
//   in   a realtime subscription replays other riders' batches through the same
//        `apply_ops` the UI uses, flagged `remote` so they are not bounced back.
//
// Failure is always soft. No account, no network, or no published trip and the
// app behaves exactly as it did before any of this existed.
export function useTripSync(state, dispatch) {
  const { remote, outbox } = state;
  const [status, setStatus] = useState('offline'); // offline | live | syncing | error
  const [user, setUser] = useState(null);
  const busy = useRef(false);
  // Render-synced refs: the effects below run from stale closures.
  const tripRef = useRef(state.trip);
  tripRef.current = state.trip;
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  const seqRef = useRef(remote?.seq ?? 0);
  seqRef.current = remote?.seq ?? 0;

  // who is signed in
  useEffect(() => {
    if (!SYNC_ENABLED) return undefined;
    currentUser().then(setUser);
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  // catch up on anything missed while the tab was closed, then go live
  useEffect(() => {
    if (!SYNC_ENABLED || !user || !remote?.tripId) { setStatus('offline'); return undefined; }
    let alive = true;

    (async () => {
      try {
        const { row, ops } = await fetchTrip(remote.tripId);
        if (!alive) return;
        // Fallen behind the snapshot? The ops between this device's seq and
        // snapshot_seq are no longer fetchable — and after the owner folds the
        // log (compaction below), the snapshot IS the group's truth. Adopt it
        // wholesale and replay what came after. This is also the repair path
        // for a replica that DIVERGED under the old non-deterministic-id bug:
        // one fold on the owner's phone, and every stale device snaps to the
        // real plan on its next catch-up. Skipped while local edits are still
        // queued — the drain empties the outbox and the next pass adopts.
        if ((remote.seq ?? 0) < (row.snapshot_seq ?? 0) && !outboxRef.current.length) {
          let trip = row.snapshot;
          if (ops.length) trip = applyOps(trip, ops.flatMap((r) => r.ops)).trip;
          dispatch({ type: 'load_trip', trip });
          dispatch({ type: 'set_remote', remote: { ...remote, seq: ops.at(-1)?.seq ?? row.snapshot_seq } });
          if (alive) setStatus('live');
          return;
        }
        const missed = ops.filter((r) => r.seq > (remote.seq ?? 0));
        if (missed.length) {
          // This device's own batches were applied optimistically when they
          // were made — replaying them after a reload duplicates every added
          // stop and day. They still advance seq, or the next catch-up would
          // re-read them forever.
          const foreign = missed.filter((r) => r.client_id !== CLIENT_ID);
          if (foreign.length) dispatch({ type: 'apply_ops', ops: foreign.flatMap((r) => r.ops), remote: true });
          dispatch({ type: 'set_remote', remote: { ...remote, seq: missed[missed.length - 1].seq } });
        }
        if (alive) setStatus('live');
      } catch {
        if (alive) setStatus('error');
      }
    })();

    const off = subscribeOps(remote.tripId, ({ seq, ops }) => {
      dispatch({ type: 'apply_ops', ops, remote: true });
      // never regress seq — the drain may have advanced it past this insert
      dispatch({ type: 'set_remote', remote: { ...remote, seq: Math.max(seqRef.current, seq) } });
    });
    return () => { alive = false; off(); };
  }, [user, remote?.tripId]); // eslint-disable-line react-hooks/exhaustive-deps

  // drain the outbox
  useEffect(() => {
    if (!SYNC_ENABLED || !user || !remote?.tripId || !outbox.length || busy.current) return;
    busy.current = true;
    setStatus('syncing');
    (async () => {
      const sent = [];
      let lastSeq = null;
      try {
        // Oldest first and strictly sequential: op order is the whole contract.
        for (const batch of outbox) {
          lastSeq = await pushOps(remote.tripId, batch.ops);
          sent.push(batch.id);
        }
        // Fold the log into the snapshot with the state these ops produced.
        // Owner-only by RLS — a rider's call is a silent no-op. Keeps late
        // joins fast and gives diverged replicas a clean truth to adopt
        // (see the catch-up above).
        if (lastSeq != null) Promise.resolve(compact(remote.tripId, tripRef.current, lastSeq)).catch(() => {});
        setStatus('live');
      } catch {
        setStatus('error'); // whatever did not send stays queued for the retry
      } finally {
        if (sent.length) dispatch({ type: 'outbox_sent', ids: sent });
        // Advance past our own accepted writes so the next catch-up doesn't
        // even have to fetch-and-discard them.
        if (lastSeq != null) {
          dispatch({ type: 'set_remote', remote: { ...remote, seq: Math.max(remote.seq ?? 0, lastSeq) } });
        }
        busy.current = false;
      }
    })();
  }, [user, remote?.tripId, outbox]); // eslint-disable-line react-hooks/exhaustive-deps

  // a failed push should not sit there forever if the signal comes back quietly
  useEffect(() => {
    if (status !== 'error' || !outbox.length) return undefined;
    const t = setTimeout(() => { busy.current = false; setStatus('offline'); }, 15000);
    return () => clearTimeout(t);
  }, [status, outbox.length]);

  return { status, user, pending: outbox.length, enabled: SYNC_ENABLED };
}

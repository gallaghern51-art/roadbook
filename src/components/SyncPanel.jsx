import React, { useEffect, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { useT } from '../engine/settings.jsx';
import {
  SYNC_ENABLED, leaveTrip,
  publishTrip, joinTrip, fetchTrip, fetchMembers,
} from '../engine/supabase.js';

// One door.
//
// There is no sign-in step and no account to choose between. A device gets an
// anonymous session the first time it shares or joins, so the only thing a
// human handles is a name and a code — the two facts a rider already has. The
// previous version forked: riders on a code, the organiser on a magic link.
// Two mental models for one group of seven people who already trust each other.
//
// There is no email anywhere, and that is deliberate rather than lazy:
// Supabase's built-in sender allows roughly two messages an hour on this plan,
// so any email step would fail for most of a seven-rider group signing in at
// once — the exact moment it has to work. The code is the credential. Lose the
// phone, open the app on a new one, type the code, you are back in.
export default function SyncPanel({ sync }) {
  const { state, dispatch } = useTrip();
  const t = useT();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState([]);
  const remote = state.remote;

  useEffect(() => {
    if (!remote?.tripId || !sync.user) return;
    fetchMembers(remote.tripId).then(setMembers);
  }, [remote?.tripId, sync.user, sync.status]);

  if (!SYNC_ENABLED) {
    return (
      <div className="set-sync">
        <span className="set-label">{t('Share')}</span>
        <p className="set-note">{t('Sharing is not configured on this build.')}</p>
      </div>
    );
  }

  const run = async (fn, ok) => {
    setBusy(true); setNote('');
    try { await fn(); setNote(ok); } catch (e) { setNote(e.message || String(e)); }
    setBusy(false);
  };

  const adopt = async (tripId) => {
    const { row, ops } = await fetchTrip(tripId);
    dispatch({ type: 'load_trip', trip: row.snapshot });
    if (ops.length) dispatch({ type: 'apply_ops', ops: ops.flatMap((r) => r.ops), remote: true });
    dispatch({
      type: 'set_remote',
      remote: { tripId, joinCode: row.join_code, seq: ops.at(-1)?.seq ?? row.snapshot_seq },
    });
  };

  // ---- on a shared trip ----
  if (remote?.joinCode) {
    return (
      <div className="set-sync">
        <span className="set-label">{t('Share')}</span>
        <p className="set-note">{t('Riders join with this code. Everything they change appears here.')}</p>
        <div className="join-code">{remote.joinCode}</div>
        <p className={`sync-status ${sync.status}`}>
          {sync.status === 'live' && t('Live')}
          {sync.status === 'syncing' && `${t('Syncing')} · ${sync.pending}`}
          {sync.status === 'error' && `${t('Waiting for signal')} · ${sync.pending}`}
          {sync.status === 'offline' && t('Offline')}
        </p>
        {members.length > 0 && (
          <ul className="rider-list">
            {members.map((m) => <li key={m.user_id}>{m.name || t('Rider')}</li>)}
          </ul>
        )}

        <p className="set-note">{t('Keep this code. It is how you get back in on a new phone.')}</p>

        {note && <p className="set-note">{note}</p>}
        {/* Leaving unbinds THIS device from the shared trip. It is not a
            sign-out: an account holder keeps their session, backup and
            profile — leaving one trip used to log them out of everything. */}
        <button
          className="btn set-signout"
          disabled={busy}
          onClick={() => run(async () => {
            await leaveTrip(remote.tripId);
            dispatch({ type: 'set_remote', remote: null }); // also drops the outbox
            setMembers([]);
          }, t('You have left the shared trip. Your copy stays on this device.'))}
        >{t('Leave this trip')}</button>
      </div>
    );
  }

  // ---- not shared yet: two verbs, no account ----
  return (
    <div className="set-sync">
      <span className="set-label">{t('Share')}</span>
      <p className="set-note">{t('Your name, so the others know who is who.')}</p>
      <div className="sync-row">
        <input value={name} placeholder={t('Your name')} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="sync-row">
        <button
          className="btn gold"
          disabled={busy || !name.trim()}
          onClick={() => run(async () => {
            const { id, joinCode } = await publishTrip(state.trip, state.trip.meta.title, name.trim());
            dispatch({ type: 'set_remote', remote: { tripId: id, joinCode, seq: 0 } });
          }, t('Shared. Send the code to your riders.'))}
        >{t('Share this trip')}</button>
      </div>

      <div className="sync-or">{t('or')}</div>

      <div className="sync-row">
        <input
          className="code-in" value={code} placeholder={t('Join code')}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
        />
        <button
          className="btn"
          disabled={busy || code.trim().length < 4 || !name.trim()}
          onClick={() => run(async () => {
            const tripId = await joinTrip(code, name.trim());
            await adopt(tripId);
          }, t('Joined.'))}
        >{t('Join trip')}</button>
      </div>

      {note && <p className="set-note">{note}</p>}
    </div>
  );
}

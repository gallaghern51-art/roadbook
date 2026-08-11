import React, { useMemo, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { useT } from '../engine/settings.jsx';

// The plan switcher AND manager, on the PLAN surface where the plan is
// looked at. Chips are saved versions of THIS trip — created here with
// "Save plan as…", or automatically whenever Copilot applies a restructure
// (its "saves as" name lands in this strip).
//
// Loading while the trip is SHARED forks a real decision, so it is asked
// explicitly: adopt for the whole group (the swap ships through the op log,
// so every rider receives it live), or "Just me — new trip" — "I'm leaving
// early Thursday, the rest are staying" is a personal trip, not a group
// edit, and the plan mechanism must never silently overwrite seven riders'
// plan.

// Seed a saved plan into its own UNSHARED trip: fresh record, no remote
// binding, so nothing the rider does on it ever reaches the group's op log.
// Shared with FeasibilityPanel so both fork doors behave identically.
export function forkScenarioToTrip(dispatch, scen) {
  const solo = structuredClone(scen.trip);
  solo.meta = { ...solo.meta, title: scen.name };
  dispatch({ type: 'create_trip', trip: solo, name: scen.name });
}

export default function ScenarioStrip({ compact = false }) {
  const { state, dispatch } = useTrip();
  const t = useT();
  const [open, setOpen] = useState(!compact); // compact = day panels: a one-line pill until tapped
  const [pick, setPick] = useState(null); // saved plan awaiting its action row
  const [saving, setSaving] = useState(false);
  const [copying, setCopying] = useState(false);
  const [name, setName] = useState('');
  const [armDelete, setArmDelete] = useState(false);
  const scenarios = state.scenarios ?? [];
  const shared = !!state.remote?.tripId;
  const chosen = scenarios.find((s) => s.id === pick);
  const active = scenarios.find((s) => s.id === state.activeScenarioId);

  // has the working plan drifted from the version it was loaded from?
  const dirty = useMemo(() => {
    if (!active) return false;
    try { return JSON.stringify(active.trip) !== JSON.stringify(state.trip); } catch { return false; }
  }, [active, state.trip]);

  const closeRows = () => { setPick(null); setSaving(false); setCopying(false); setArmDelete(false); };
  const pickChip = (id) => {
    setPick(pick === id ? null : id);
    setSaving(false);
    setCopying(false);
    setArmDelete(false);
  };
  const loadForAll = (id) => {
    dispatch({ type: 'load_scenario', id, broadcast: shared });
    setPick(null);
  };
  const forkForMe = (scen) => {
    forkScenarioToTrip(dispatch, scen);
    setPick(null);
  };
  // Fork the CURRENT working plan without the save-a-plan detour. On a shared
  // trip this is the safe way to START a personal variant — hand-editing the
  // shared plan first would broadcast every op to the group live.
  const copyCurrent = () => {
    const solo = structuredClone(state.trip);
    solo.meta = { ...solo.meta, title: `${solo.meta?.title ?? 'Trip'} — ${shared ? 'personal' : 'copy'}` };
    dispatch({ type: 'create_trip', trip: solo, name: solo.meta.title });
    setCopying(false);
  };
  const saveNew = () => {
    const n = name.trim();
    if (!n) return;
    dispatch({ type: 'save_scenario', name: n });
    setName('');
    setSaving(false);
  };
  const deleteChosen = () => {
    if (!armDelete) {
      setArmDelete(true);
      setTimeout(() => setArmDelete(false), 3000);
      return;
    }
    dispatch({ type: 'delete_scenario', id: chosen.id });
    setPick(null);
    setArmDelete(false);
  };

  // Day panels get a one-line pill: the full strip repeated under every day
  // read as a day-scoped control ("does this save just Thursday?"). The pill
  // answers "which plan am I on" and expands to the real strip on tap.
  if (compact && !open) {
    return (
      <button className="scen-strip ss-pill" onClick={() => setOpen(true)}>
        <span className="ss-label">{t('Plan')}</span>
        <span className="ss-cur">{active ? active.name : t('Current')}{dirty ? ' •' : ''}</span>
        <span className="ss-caret">▾</span>
      </button>
    );
  }

  return (
    <div className="scen-strip">
      <div className="ss-head">
        <span className="ss-label">{t('Plans')}</span>
        <div className="ss-chips">
          {/* "what am I on right now?" always has an answer: when no saved
              plan is active, a lit Current chip says so — tapping it offers
              to name the working plan */}
          {!active && (
            <button
              className={`ss-chip active${saving ? ' picked' : ''}`}
              title={t('The working plan — unsaved. Tap to name it.')}
              onClick={() => { closeRows(); setSaving(true); }}
            >{t('Current')}</button>
          )}
          {scenarios.map((s) => (
            <button
              key={s.id}
              className={`ss-chip${s.id === state.activeScenarioId ? ' active' : ''}${s.id === pick ? ' picked' : ''}${/^Auto-saved /.test(s.name) ? ' auto' : ''}`}
              onClick={() => pickChip(s.id)}
            >{s.name}{s.id === state.activeScenarioId && dirty ? ' •' : ''}</button>
          ))}
          <button
            className={`ss-chip ss-add${saving ? ' picked' : ''}`}
            onClick={() => { const v = saving; closeRows(); setSaving(!v); }}
          >＋ {t('Save plan as…')}</button>
          <button
            className={`ss-chip ss-add${copying ? ' picked' : ''}`}
            onClick={() => { const v = copying; closeRows(); setCopying(!v); }}
          >⑂ {shared ? t('Personal copy') : t('Duplicate trip')}</button>
        </div>
        {compact && (
          <button className="ss-caret" onClick={() => { closeRows(); setOpen(false); }}>▴</button>
        )}
      </div>

      {saving && (
        <div className="ss-confirm">
          <input
            className="ss-name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveNew(); }}
            placeholder={t('Name this version — e.g. Solo Thursday')}
          />
          <button className="btn gold" disabled={!name.trim()} onClick={saveNew}>{t('Save')}</button>
          <p className="ss-note">{t('Snapshots the whole current plan under a name. Copilot restructures land here automatically too.')}</p>
        </div>
      )}

      {copying && (
        <div className="ss-confirm">
          <button className="btn gold" onClick={copyCurrent}>{t('Create my copy')}</button>
          <button className="btn" onClick={() => setCopying(false)}>{t('Cancel')}</button>
          <p className="ss-note">
            {shared
              ? t('A separate copy of the current plan as its own trip on this phone — unshared, so nothing you change there reaches the group.')
              : t('A separate copy of this trip to experiment on — the original stays as it is.')}
          </p>
        </div>
      )}

      {/* the working plan drifted from the loaded version — offer to write
          the edits back into it (this is how a saved plan is EDITED) */}
      {dirty && !saving && !copying && !chosen && (
        <div className="ss-confirm">
          <button className="btn" onClick={() => dispatch({ type: 'overwrite_scenario', id: active.id })}>
            {t('Update')} “{active.name}”
          </button>
          <p className="ss-note">{t('The working plan has drifted from this saved plan — Update writes your edits back into it.')}</p>
        </div>
      )}

      {/* tapping the plan you are already on must not offer to Load it */}
      {chosen && chosen.id === state.activeScenarioId && (
        <div className="ss-confirm">
          {dirty && (
            <button className="btn gold" onClick={() => { dispatch({ type: 'overwrite_scenario', id: chosen.id }); setPick(null); }}>
              {t('Update')} “{chosen.name}”
            </button>
          )}
          <button className={`btn${armDelete ? ' danger-ghost' : ''}`} onClick={deleteChosen}>
            {armDelete ? t('Sure?') : t('Delete')}
          </button>
          <button className="btn" onClick={() => setPick(null)}>{t('Cancel')}</button>
          <p className="ss-note">
            {dirty
              ? t('You are on this plan, with unsaved edits — Update writes them back into it.')
              : t('This is the current plan.')}
          </p>
        </div>
      )}

      {chosen && chosen.id !== state.activeScenarioId && (
        <div className="ss-confirm">
          {shared ? (
            <>
              <button className="btn gold" onClick={() => loadForAll(chosen.id)}>{t('Load for the group')}</button>
              <button className="btn" onClick={() => forkForMe(chosen)}>{t('Just me — new trip')}</button>
            </>
          ) : (
            <button className="btn gold" onClick={() => loadForAll(chosen.id)}>{t('Load')} “{chosen.name}”</button>
          )}
          <button className={`btn${armDelete ? ' danger-ghost' : ''}`} onClick={deleteChosen}>
            {armDelete ? t('Sure?') : t('Delete')}
          </button>
          {!shared && <button className="btn" onClick={() => setPick(null)}>{t('Cancel')}</button>}
          <p className="ss-note">
            {shared
              ? t('Group: every rider’s plan switches to this — it syncs like any other edit. Just me: a separate trip only on this phone; the group plan stays untouched.')
              : t('The current plan is auto-saved first — switching back is always possible.')}
          </p>
        </div>
      )}
    </div>
  );
}

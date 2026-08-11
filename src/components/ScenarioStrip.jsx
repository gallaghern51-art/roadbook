import React, { useMemo, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { useT } from '../engine/settings.jsx';

// The plan switcher AND manager, on the PLAN surface where the plan is
// looked at. Chips are saved permutations of THIS trip — created here with
// "Save plan as…", or automatically whenever Copilot applies a restructure
// (its "saves as" name lands in this strip).
//
// Loading while the trip is SHARED forks a real decision, so it is asked
// explicitly: adopt for the whole group (the shared plan changes for every
// rider), or split off a personal copy — "I'm leaving early Thursday, the
// rest are staying" is a personal trip, not a group edit, and the scenario
// mechanism must never silently overwrite seven riders' plan.
export default function ScenarioStrip() {
  const { state, dispatch } = useTrip();
  const t = useT();
  const [pick, setPick] = useState(null); // scenario awaiting its action row
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [armDelete, setArmDelete] = useState(false);
  const scenarios = state.scenarios ?? [];
  const shared = !!state.remote?.tripId;
  const chosen = scenarios.find((s) => s.id === pick);
  const active = scenarios.find((s) => s.id === state.activeScenarioId);

  // has the working plan drifted from the permutation it was loaded from?
  const dirty = useMemo(() => {
    if (!active) return false;
    try { return JSON.stringify(active.trip) !== JSON.stringify(state.trip); } catch { return false; }
  }, [active, state.trip]);

  const pickChip = (id) => {
    setPick(pick === id ? null : id);
    setSaving(false);
    setArmDelete(false);
  };
  const loadForAll = (id) => {
    dispatch({ type: 'load_scenario', id });
    setPick(null);
  };
  const forkForMe = (scen) => {
    // a personal, UNSHARED copy: fresh record, no remote binding, so nothing
    // the rider does on it ever reaches the group's op log
    const solo = structuredClone(scen.trip);
    solo.meta = { ...solo.meta, title: scen.name };
    dispatch({ type: 'create_trip', trip: solo, name: scen.name });
    setPick(null);
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

  return (
    <div className="scen-strip">
      <div className="ss-head">
        <span className="ss-label">{t('Plan')}</span>
        <div className="ss-chips">
          {scenarios.map((s) => (
            <button
              key={s.id}
              className={`ss-chip${s.id === state.activeScenarioId ? ' active' : ''}${s.id === pick ? ' picked' : ''}`}
              onClick={() => pickChip(s.id)}
            >{s.name}</button>
          ))}
          <button
            className={`ss-chip ss-add${saving ? ' picked' : ''}`}
            onClick={() => { setSaving((v) => !v); setPick(null); }}
          >＋ {t('Save plan as…')}</button>
        </div>
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

      {/* the working plan drifted from the loaded permutation — offer to
          write the edits back into it (this is how a scenario is EDITED) */}
      {dirty && !saving && !chosen && (
        <div className="ss-confirm">
          <button className="btn" onClick={() => dispatch({ type: 'overwrite_scenario', id: active.id })}>
            {t('Update')} “{active.name}”
          </button>
          <p className="ss-note">{t('The working plan has drifted from this permutation — Update writes your edits back into it.')}</p>
        </div>
      )}

      {chosen && (
        <div className="ss-confirm">
          {shared ? (
            <>
              <button className="btn gold" onClick={() => loadForAll(chosen.id)}>{t('Load for the group')}</button>
              <button className="btn" onClick={() => forkForMe(chosen)}>{t('Just me — personal copy')}</button>
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
              ? t('Group: this becomes the shared plan every rider sees. Just me: a separate trip only on this phone — the group plan stays untouched.')
              : t('The current plan is auto-saved first — switching back is always possible.')}
          </p>
        </div>
      )}
    </div>
  );
}

import React, { useState } from 'react';
import { useTrip } from '../engine/store.js';
import { useT } from '../engine/settings.jsx';

// The plan switcher, on the PLAN surface where the plan is looked at.
// Copilot saves permutations; this strip is how a rider actually runs one.
//
// Loading while the trip is SHARED forks a real decision, so it is asked
// explicitly: adopt for the whole group (the shared plan changes for every
// rider), or split off a personal copy — "I'm leaving early Thursday, the
// rest are staying" is a personal trip, not a group edit, and the scenario
// mechanism must never silently overwrite seven riders' plan.
export default function ScenarioStrip() {
  const { state, dispatch } = useTrip();
  const t = useT();
  const [pick, setPick] = useState(null); // scenario awaiting its confirm row
  const scenarios = state.scenarios ?? [];
  if (!scenarios.length) return null;
  const shared = !!state.remote?.tripId;
  const chosen = scenarios.find((s) => s.id === pick);

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

  return (
    <div className="scen-strip">
      <div className="ss-head">
        <span className="ss-label">{t('Plan')}</span>
        <div className="ss-chips">
          {scenarios.map((s) => (
            <button
              key={s.id}
              className={`ss-chip${s.id === state.activeScenarioId ? ' active' : ''}${s.id === pick ? ' picked' : ''}`}
              onClick={() => setPick(pick === s.id ? null : s.id)}
            >{s.name}</button>
          ))}
        </div>
      </div>
      {chosen && (
        <div className="ss-confirm">
          {shared ? (
            <>
              <button className="btn gold" onClick={() => loadForAll(chosen.id)}>{t('Load for the group')}</button>
              <button className="btn" onClick={() => forkForMe(chosen)}>{t('Just me — personal copy')}</button>
              <p className="ss-note">
                {t('Group: this becomes the shared plan every rider sees. Just me: a separate trip only on this phone — the group plan stays untouched.')}
              </p>
            </>
          ) : (
            <>
              <button className="btn gold" onClick={() => loadForAll(chosen.id)}>{t('Load')} “{chosen.name}”</button>
              <button className="btn" onClick={() => setPick(null)}>{t('Cancel')}</button>
              <p className="ss-note">{t('The current plan is auto-saved first — switching back is always possible.')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

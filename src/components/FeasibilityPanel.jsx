import React, { useState } from 'react';
import { useTrip } from '../engine/store.js';
import { tripFeasibility, fmtTime, fmtDur, gradeFor } from '../engine/timeline.js';
import { tripSummary } from '../engine/tripEngine.js';
import { splitRecommendations } from '../engine/splits.js';
import { PHASES } from '../data/seedTrip.js';
import { fmtDayDate } from '../engine/dates.js';
import { useT, useTT, useUnits } from '../engine/settings.jsx';
import { forkScenarioToTrip } from './ScenarioStrip.jsx';

// Two-tap confirm in place: first tap arms for 3 seconds, second fires. The
// stakes here are undo-able (Load) or single-row (Delete) — a dialog is more
// ceremony than the action deserves, but one tap is less than it needs.
function ArmedButton({ label, danger, onFire }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={`btn${danger || armed ? ' danger-ghost' : ''}`}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        onFire();
      }}
    >{armed ? t('Sure?') : label}</button>
  );
}

export default function FeasibilityPanel() {
  const { state, dispatch, routedLegsByDay } = useTrip();
  const { trip, scenarios } = state;
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  // On a shared trip, Load forks the same decision the Plans strip asks —
  // group swap vs personal trip — so this table can't bypass that question.
  const shared = !!state.remote?.tripId;
  const [pickId, setPickId] = useState(null);
  const picked = scenarios.find((s) => s.id === pickId);
  const feas = tripFeasibility(trip, routedLegsByDay);
  const summary = tripSummary(trip, routedLegsByDay);
  const splits = splitRecommendations(trip, routedLegsByDay);

  return (
    <div>
      <div className="day-head">
        <div className="eyebrow">{t('Engine-computed · routed miles · timed stop-by-stop')}</div>
        <h2>{t('Feasibility study')}</h2>
        <div className="datebar">
          <span className={`grade grade-${feas.grade}`}>{feas.grade}</span>
          <span className="chip">{feas.overall}/100 {t('overall')}</span>
          <span className="chip">{u.mi(summary.totalMiles)} {t('routed')}</span>
        </div>
      </div>

      <div className="section">
        <h3>{t('Day by day')}</h3>
        {trip.days.map((d) => {
          const p = feas.perDay.find((x) => x.id === d.id);
          const tl = p.timeline;
          const fails = p.issues.filter((i) => i.level === 'fail');
          const warns = p.issues.filter((i) => i.level === 'warn');
          const oks = p.issues.filter((i) => i.level === 'ok');
          return (
            <div key={d.id} className={`feas-day${p.past ? ' past' : ''}`}>
              <button className="feas-head" onClick={() => dispatch({ type: 'select_day', dayId: d.id })}>
                <span className="ph" style={{ background: PHASES[d.phase]?.color }} />
                <span className="fd-date">{d.dow} {fmtDayDate(d.date)}</span>
                <span className="fd-title">{tt(d.title)}</span>
                <span className="fd-times">{fmtTime(tl.departMin)} → {fmtTime(tl.endMin)} · {fmtDur(tl.durMin)}</span>
                <span className={`grade grade-${gradeFor(p.score)}`}>{gradeFor(p.score)}</span>
              </button>
              {[...fails, ...warns].map((i, k) => (
                <div key={k} className={`warning${i.level === 'fail' ? ' danger' : ''}`}>⚠ {tt(i.text)}</div>
              ))}
              {oks.map((i, k) => (
                <div key={`ok${k}`} className="feas-ok">✓ {tt(i.text)}</div>
              ))}
              {splits.filter((r) => r.dayId === d.id).map((r, k) => (
                <div key={`sp${k}`} className="split-rec">
                  <div className="sr-label">{r.type === 'loop' ? t('◎ How to break this loop') : t('✂ Where to split this day')}</div>
                  <div>{tt(r.text)}</div>
                  <button
                    className="btn"
                    onClick={() => dispatch({
                      type: 'ask_optimizer',
                      text: `Restructure ${d.dow} (${d.title}) using this break point analysis: "${r.text}" Rework the trip so this day becomes feasible — move stops to neighboring days, retime departures, or trim — keep the anchor days intact, and save the result as a scenario.`,
                    })}
                  >{t('Have the optimizer restructure it →')}</button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="section">
        <h3>{t('Saved plans')} <span className="cnt">{scenarios.length}</span></h3>
        {scenarios.length === 0 && (
          <p style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>
            {t('None yet. Save one from the Plans strip at the top of the trip overview — or ask Copilot to restructure the trip and save the result — then compare plans here and swap between them.')}
          </p>
        )}
        {scenarios.length > 0 && (
          <div className="table-wrap">
            <table className="scen-table">
              <thead>
                <tr><th>{t('Plan')}</th><th>{u.metric ? 'Km' : t('Miles')}</th><th>{t('Feas.')}</th><th></th><th></th></tr>
              </thead>
              <tbody>
                <tr className="current">
                  <td>{t('Current working plan')}</td>
                  <td>{u.miNum(summary.totalMiles)}</td>
                  <td><span className={`grade grade-${feas.grade}`}>{feas.grade} {feas.overall}</span></td>
                  <td colSpan={2} />
                </tr>
                {scenarios.map((s) => {
                  const sf = tripFeasibility(s.trip, routedLegsByDay);
                  const ss = tripSummary(s.trip, routedLegsByDay);
                  return (
                    <tr key={s.id} className={s.id === pickId ? 'picked' : undefined}>
                      <td>{s.name}<div className="scen-date">{new Date(s.savedAt).toLocaleDateString()} {new Date(s.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></td>
                      <td>{u.miNum(ss.totalMiles)}</td>
                      <td><span className={`grade grade-${sf.grade}`}>{sf.grade} {sf.overall}</span></td>
                      <td>
                        {shared
                          ? <button className="btn" onClick={() => setPickId(pickId === s.id ? null : s.id)}>{t('Load')}…</button>
                          : <ArmedButton label={t('Load')} onFire={() => dispatch({ type: 'load_scenario', id: s.id })} />}
                      </td>
                      <td><ArmedButton label="✕" danger onFire={() => { dispatch({ type: 'delete_scenario', id: s.id }); if (pickId === s.id) setPickId(null); }} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {picked && (
          <div className="ss-confirm">
            <button className="btn gold" onClick={() => { dispatch({ type: 'load_scenario', id: picked.id, broadcast: true }); setPickId(null); }}>{t('Load for the group')}</button>
            <button className="btn" onClick={() => { forkScenarioToTrip(dispatch, picked); setPickId(null); }}>{t('Just me — new trip')}</button>
            <button className="btn" onClick={() => setPickId(null)}>{t('Cancel')}</button>
            <p className="ss-note">{t('Group: every rider’s plan switches to this — it syncs like any other edit. Just me: a separate trip only on this phone; the group plan stays untouched.')}</p>
          </div>
        )}
      </div>

      <p style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 14 }}>
        {t('Method: departure times from each day\'s plan, routed leg durations (OSRM, speed-calibrated for real highway pace, scaled by the trip\'s group-pace setting), planned time-on-ground at every stop, checked against the trip\'s hard gates, its configured fuel range, its dusk setting, and booking status. Saved-plan rows use cached routing where available and planned mileage otherwise.')}
      </p>
    </div>
  );
}

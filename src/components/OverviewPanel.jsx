import React from 'react';
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTrip } from '../engine/store.js';
import { PHASES } from '../data/seedTrip.js';
import { fmtDayDate, fmtLongDate } from '../engine/dates.js';
import { useT, useTT, useUnits } from '../engine/settings.jsx';
import { uid } from '../engine/ops.js';
import { tripPace, tripRoutePrefs } from '../engine/tripEngine.js';
import { to24h, from24h } from '../engine/timeline.js';
import ScenarioStrip from './ScenarioStrip.jsx';

// Suggestions only — riders type whatever they actually ride. (The list began
// as the EagleRider rental lineup the Sturgis crew booked from; it survives as
// autocomplete, not as the universe of motorcycles.)
const BIKE_SUGGESTIONS = [
  'Street Glide', 'Street Glide Ultra', 'Road Glide', 'Road Glide Ultra',
  'Electra Glide', 'Road King', 'Heritage Softail Classic',
  'CVO Street Glide', 'CVO Road Glide', 'Pan America 1250',
  'BMW R 1300 GS', 'Honda Gold Wing', 'KTM 1290 Super Adventure', 'Indian Roadmaster',
];

const ROUTE_STYLE_UI = [
  { id: 'quick', label: 'Quick', copy: 'Favors the fastest practical roads, including highways.' },
  { id: 'touring', label: 'Touring', copy: 'Balances highway progress with good motorcycle roads.' },
  { id: 'backroads', label: 'Back roads', copy: 'Strongly favors secondary roads. Expect longer days.' },
];

export default function OverviewPanel() {
  const { state, dispatch, summary, ui } = useTrip();
  const { trip } = state;
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  // The whole day row is the drag handle, so on touch the drag has to wait out
  // a press-and-hold — otherwise the list could never be scrolled.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
  const reorderHint = ui?.isMobile ? 'press & hold to reorder' : 'drag to reorder';

  const onDragEnd = (e) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = trip.days.map((d) => d.id);
    const next = arrayMove(ids, ids.indexOf(active.id), ids.indexOf(over.id));
    dispatch({ type: 'apply_ops', ops: [{ op: 'reorder_days', dayIds: next }] });
  };

  return (
    <div>
      <div className="day-head">
        <div className="eyebrow">{tt(trip.meta.subtitle)}</div>
        <h2>{t('The whole trip at a glance')}</h2>
        <ScenarioStrip />
        <div className="datebar">
          <span className="chip">{trip.days[0]?.dow} {fmtLongDate(trip.days[0]?.date ?? trip.meta.startDate)} → {trip.days[trip.days.length - 1]?.dow} {fmtLongDate(trip.days[trip.days.length - 1]?.date ?? trip.meta.startDate)}</span>
          <span className="chip">{u.mi(summary.totalMiles)}</span>
          <span className="chip">{trip.meta.nights} {t('nights')}</span>
          <span className="chip">{trip.meta.riders} {t('riders')}</span>
        </div>
      </div>

      {/* The trip's own description, not instructions — the drag hint lives on
          the Days header where the dragging actually happens. */}
      {trip.meta.summary && (
        <p className="trip-summary">{tt(trip.meta.summary)}</p>
      )}

      <div className="section">
        <h3>{t('Days')} <span className="cnt">{t(reorderHint)} · {t('dates stay pinned to the calendar')}</span></h3>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={trip.days.map((d) => d.id)} strategy={verticalListSortingStrategy}>
            <div className="ov-days">
              {trip.days.map((d) => <SortableDay key={d.id} day={d} summary={summary} dispatch={dispatch} />)}
            </div>
          </SortableContext>
        </DndContext>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => dispatch({ type: 'apply_ops', ops: [{ op: 'add_day' }] })}>＋ {t('Add day')}</button>
      </div>

      <TripSettings trip={trip} dispatch={dispatch} ui={ui} />

      {trip.fieldNotes && <div className="section fieldnotes">
        <h3>{t('Field notes')}</h3>
        <h4>{t('Fuel discipline')}</h4>
        <ul>{trip.fieldNotes.fuel.map((x, i) => <li key={i}>{tt(x)}</li>)}</ul>
        <h4>{t('Intercom')}</h4>
        <ul>{trip.fieldNotes.intercom.map((x, i) => <li key={i}>{tt(x)}</li>)}</ul>
        <h4>{t('Cash & passes')}</h4>
        <ul>{trip.fieldNotes.cash.map((x, i) => <li key={i}>{tt(x)}</li>)}</ul>
        <h4>{t('Altitude')}</h4>
        <ul>{trip.fieldNotes.altitude.map((x, i) => <li key={i}>{tt(x)}</li>)}</ul>
        <h4>{t('Emergency')}</h4>
        <ul>{trip.fieldNotes.emergency.map((x, i) => <li key={i}>{tt(x)}</li>)}</ul>
      </div>}

      <RiderRoster trip={trip} dispatch={dispatch} />
    </div>
  );
}

// Who's riding what. Lives on the trip (meta.roster via set_meta), so it
// exports/imports with the itinerary rather than staying on one device.
function RiderRoster({ trip, dispatch }) {
  const t = useT();
  const roster = trip.meta.roster ?? [];
  const save = (next) => dispatch({ type: 'apply_ops', ops: [{ op: 'set_meta', patch: { roster: next } }] });
  const update = (id, patch) => save(roster.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="section">
      <h3>{t('Rider roster')} <span className="cnt">{t('name + bike, saved on the trip')}</span></h3>
      <datalist id="bike-suggestions">
        {BIKE_SUGGESTIONS.map((b) => <option key={b} value={b} />)}
      </datalist>
      {roster.map((r) => (
        <div key={r.id} className="roster-row">
          <input
            placeholder={t('Rider name')}
            defaultValue={r.name}
            onBlur={(e) => { if (e.target.value !== r.name) update(r.id, { name: e.target.value }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
          <input
            list="bike-suggestions"
            placeholder={t('Bike — type anything')}
            defaultValue={r.bike || ''}
            onBlur={(e) => { if (e.target.value !== (r.bike || '')) update(r.id, { bike: e.target.value }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
          <button className="mini-edit" title={t('Cancel')} onClick={() => save(roster.filter((x) => x.id !== r.id))}>✕</button>
        </div>
      ))}
      <button
        className="btn"
        style={{ fontSize: 11, padding: '3px 9px', marginTop: roster.length ? 6 : 0 }}
        onClick={() => save([...roster, { id: uid('rider'), name: '', bike: '' }])}
      >＋ {t('Add rider')}</button>
    </div>
  );
}

function TripSettings({ trip, dispatch, ui }) {
  const t = useT();
  const set = (patch) => dispatch({ type: 'apply_ops', ops: [{ op: 'set_meta', patch }] });
  const range = { comfort: 180, absolute: 200, mpg: 45, ...(trip.meta.range ?? {}) };
  const routePrefs = tripRoutePrefs(trip);
  const activeRoute = ROUTE_STYLE_UI.find((x) => x.id === routePrefs.style) ?? ROUTE_STYLE_UI[1];
  const setRange = (k, v) => set({ range: { ...range, [k]: Number(v) || 0 } });
  const setRoutePrefs = (patch) => {
    const next = { ...routePrefs, ...patch };
    if (next.style === routePrefs.style && next.avoidTolls === routePrefs.avoidTolls) return;
    ui?.beginRoutePreview?.(next);
  };
  const routeLoad = ui?.routeLoad;
  return (
    <div className="section">
      <h3>{t('Trip settings')}</h3>
      <div className="budget-grid trip-settings-grid">
        <label className="fld settings-wide">{t('Trip name')}
          <input defaultValue={trip.meta.title} key={trip.meta.title}
            onBlur={(e) => { if (e.target.value.trim() && e.target.value !== trip.meta.title) set({ title: e.target.value.trim() }); }} />
        </label>
        <label className="fld settings-wide">{t('Trip summary')}
          <textarea rows={3} defaultValue={trip.meta.summary ?? ''} key={trip.meta.summary}
            onBlur={(e) => { if (e.target.value !== (trip.meta.summary ?? '')) set({ summary: e.target.value }); }} />
        </label>
        <div className="route-pref" aria-busy={Boolean(routeLoad)}>
          <div className="route-pref-head">
            <div>
              <div className="route-pref-label">{t('Route character')}</div>
              <div className="route-pref-scope">{t('Preview the impact before it touches the trip')}</div>
            </div>
            <span className={`route-engine${routeLoad ? ' working' : ''}`} role="status" aria-live="polite">
              <i /> {routeLoad ? <>{t('Routing')} {routeLoad.done}/{routeLoad.total}</> : t('Valhalla motorcycle')}
            </span>
          </div>
          <div className="route-style-grid" role="radiogroup" aria-label={t('Route character')}>
            {ROUTE_STYLE_UI.map((style) => (
              <button
                type="button"
                role="radio"
                aria-checked={routePrefs.style === style.id}
                className={`${routePrefs.style === style.id ? 'active' : ''}${routeLoad && routePrefs.style === style.id ? ' is-routing' : ''}${ui?.routePreview?.prefs?.style === style.id ? ' previewing' : ''}`.trim()}
                key={style.id}
                disabled={Boolean(routeLoad)}
                onClick={() => setRoutePrefs({ style: style.id })}
              >
                <span>{t(style.label)}</span>
                <small>{t(style.copy)}</small>
              </button>
            ))}
          </div>
          <div className="route-pref-foot">
            <p><b>{t(activeRoute.label)}</b> · {t(activeRoute.copy)}</p>
            <label className="route-tolls">
              <input
                type="checkbox"
                checked={routePrefs.avoidTolls}
                disabled={Boolean(routeLoad)}
                onChange={(e) => setRoutePrefs({ avoidTolls: e.target.checked })}
              />
              <span>{t('Avoid toll roads')}</span>
            </label>
          </div>
        </div>
        <label className="fld settings-third settings-start">{t('Start date')}
          <input type="date" value={trip.meta.startDate}
            onChange={(e) => { if (e.target.value) set({ startDate: e.target.value }); }} />
        </label>
        <label className="fld settings-third">{t('Riders')}
          <input type="number" min="1" value={trip.meta.riders}
            onChange={(e) => set({ riders: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label className="fld settings-third">{t('Group pace buffer %')}
          <input type="number" min="0" max="50" step="1"
            value={Math.round((tripPace(trip) - 1) * 100)}
            onChange={(e) => set({ pace: 1 + Math.max(0, Math.min(50, Number(e.target.value) || 0)) / 100 })} />
        </label>
        <label className="fld settings-third">{t('Range: comfort mi')}
          <input type="number" min="40" value={range.comfort} onChange={(e) => setRange('comfort', e.target.value)} />
        </label>
        <label className="fld settings-third">{t('Range: absolute mi')}
          <input type="number" min="50" value={range.absolute} onChange={(e) => setRange('absolute', e.target.value)} />
        </label>
        <label className="fld settings-third">MPG
          <input type="number" min="10" value={range.mpg} onChange={(e) => setRange('mpg', e.target.value)} />
        </label>
        <label className="fld settings-half settings-dusk">{t('Dusk (after-dark warnings)')}
          <input type="time" defaultValue={to24h(trip.meta.dusk ?? '8:30 PM')} key={trip.meta.dusk}
            onBlur={(e) => {
              const v = from24h(e.target.value);
              if (v && v !== (trip.meta.dusk ?? '8:30 PM')) set({ dusk: v });
            }} />
        </label>
        <label className="fld settings-half">{t('UTC offset (calendar export)')}
          <input type="number" min="-12" max="14" step="0.5" value={Number.isFinite(trip.meta.utcOffset) ? trip.meta.utcOffset : -6}
            onChange={(e) => set({ utcOffset: Number(e.target.value) })} />
        </label>
      </div>
      <p className="trip-settings-note">
        {t('Changing the start date re-pins every day to the new calendar. Fuel warnings and feasibility use the bike range set here.')}{' '}
        {t('Dusk drives the after-dark warnings; the UTC offset places .ics calendar times in the trip’s zone.')}{' '}
        {t('The pace buffer slows every planned leg for group riding — set 0 for a solo trip, 15+ for a big group.')}
      </p>
      {ui?.routePreview && (
        <RouteCharacterPreview
          trip={trip}
          preview={ui.routePreview}
          onClose={ui.closeRoutePreview}
          onRetry={() => ui.beginRoutePreview(ui.routePreview.prefs)}
          onApply={ui.applyRoutePreview}
          onResearch={ui.researchRouteAlternatives}
        />
      )}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
      <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

const minutesLabel = (minutes) => {
  const total = Math.round(Math.abs(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return hours ? `${hours}h ${mins ? `${mins}m` : ''}`.trim() : `${mins}m`;
};

function RouteCharacterPreview({ trip, preview, onClose, onRetry, onApply, onResearch }) {
  const t = useT();
  const u = useUnits();
  const dialogRef = React.useRef(null);
  const closeRef = React.useRef(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const current = ROUTE_STYLE_UI.find((style) => style.id === tripRoutePrefs(trip).style) ?? ROUTE_STYLE_UI[1];
  const target = ROUTE_STYLE_UI.find((style) => style.id === preview.prefs.style) ?? ROUTE_STYLE_UI[1];
  const analysis = preview.analysis;
  const signedDistance = (miles) => `${miles > 0 ? '+' : miles < 0 ? '-' : ''}${u.mi(Math.abs(Math.round(miles)))}`;
  const signedMinutes = (minutes) => `${minutes > 0 ? '+' : minutes < 0 ? '-' : ''}${minutesLabel(minutes)}`;
  const booked = analysis?.inventory.hard.filter((item) => item.kind === 'lodging').length ?? 0;
  const timed = analysis?.inventory.hard.filter((item) => item.kind === 'gate' || item.kind === 'reservation').length ?? 0;
  const progress = preview.total ? Math.round((preview.done / preview.total) * 100) : 0;

  React.useEffect(() => {
    const returnFocus = document.activeElement;
    closeRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((node) => !node.hasAttribute('hidden'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop route-preview-backdrop" onClick={onClose}>
      <section
        ref={dialogRef}
        className="modal route-preview-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="route-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="route-preview-head">
          <div>
            <h3 id="route-preview-title">{t(current.label)} <span aria-hidden="true">→</span> {t(target.label)}</h3>
            <p>{t('Nothing is saved until you choose how Roadbook should handle the stops.')}</p>
          </div>
          <button ref={closeRef} className="btn icon route-preview-close" onClick={onClose} aria-label={t('Close')}><CloseIcon /></button>
        </header>

        <div className="route-preview-body">
          {preview.status === 'loading' && (
            <div className="route-preview-loading" role="status" aria-live="polite">
              <div className="route-preview-route-mark"><i /><i /><i /></div>
              <h4>{t('Testing every day against the new road character')}</h4>
              <p>{t('Current stops stay in place while Valhalla measures the alternate roads.')}</p>
              <div className="route-preview-progress"><i style={{ '--route-progress': progress / 100 }} /></div>
              <span>{t('Routing')} {preview.done}/{preview.total}</span>
            </div>
          )}

          {preview.status === 'error' && (
            <div className="route-preview-error" role="alert">
              <h4>{t('The comparison could not finish')}</h4>
              <p>{preview.error}</p>
              <button className="btn" onClick={onRetry}>{t('Try again')}</button>
            </div>
          )}

          {preview.status === 'ready' && analysis && (
            <>
              <div className="route-preview-metrics" aria-label={t('Route impact')}>
                <div>
                  <span>{t('Distance')}</span>
                  <strong>{u.mi(Math.round(analysis.candidate.miles))}</strong>
                  <small className={analysis.deltaMiles > 0 ? 'cost' : 'gain'}>{signedDistance(analysis.deltaMiles)}</small>
                </div>
                <div>
                  <span>{t('Riding time')}</span>
                  <strong>{minutesLabel(analysis.candidate.rideMinutes)}</strong>
                  <small className={analysis.deltaMinutes > 0 ? 'cost' : 'gain'}>{signedMinutes(analysis.deltaMinutes)}</small>
                </div>
                <div>
                  <span>{t('Feasibility')}</span>
                  <strong>{analysis.candidate.grade} <em>{analysis.candidate.score}</em></strong>
                  <small>{analysis.current.grade} {analysis.current.score} {t('before')}</small>
                </div>
              </div>

              <div className="route-commitment-band">
                <div>
                  <b>{booked + timed}</b>
                  <span>{t('commitments locked')}</span>
                </div>
                <p>{booked} {t('booked stays')} · {timed} {t('timed commitments')} · {analysis.inventory.preservedRouteStops} {t('route stops held')}</p>
              </div>

              <section className="route-impact-section">
                <div className="route-impact-heading">
                  <h4>{t('What changes')}</h4>
                  <span>{analysis.changedDays.length}/{trip.days.length} {t('days affected')}</span>
                </div>
                {analysis.changedDays.length ? (
                  <div className="route-day-deltas">
                    {analysis.changedDays.map((day) => (
                      <div className="route-day-delta" key={day.id}>
                        <div><span>{day.label}</span><b>{day.title}</b></div>
                        <p><strong>{signedDistance(day.deltaMiles)}</strong><span>{signedMinutes(day.deltaMinutes)}</span></p>
                      </div>
                    ))}
                  </div>
                ) : <p className="route-impact-quiet">{t('The measured day shapes stay effectively the same.')}</p>}
              </section>

              <section className="route-impact-section">
                <div className="route-impact-heading">
                  <h4>{t('Trip checks')}</h4>
                  <span>{analysis.introducedWarnings.length} {t('new warnings')}</span>
                </div>
                {analysis.introducedWarnings.length ? (
                  <ul className="route-warning-list">
                    {analysis.introducedWarnings.map((warning, index) => (
                      <li key={`${warning.dayId}-${index}`}><b>{warning.day}</b><span>{warning.text}</span></li>
                    ))}
                  </ul>
                ) : <p className="route-impact-quiet">{t('No new fuel, duration, or continuity warnings.')}</p>}
              </section>

              {analysis.inventory.unlinked.length > 0 && (
                <div className="route-place-note">
                  <b>{analysis.inventory.unlinked.length} {t('place records need a corridor check')}</b>
                  <p>{t('These restaurant or lodging records are not route pins. Booked stays remain locked; Roadbook can align them precisely and research replacements only for flexible places.')}</p>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="route-preview-actions">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          {preview.status === 'ready' && (
            <>
              <button className="btn" onClick={() => onResearch(target.label)}>{t('Find better-fit stops')}</button>
              <button className="btn gold" onClick={onApply}>{t('Keep every stop')}</button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function SortableDay({ day, summary, dispatch }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: day.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const per = summary.perDay.find((p) => p.id === day.id);
  const dangers = per?.warnings.filter((w) => w.level === 'danger').length ?? 0;
  const tt = useTT();
  const u = useUnits();
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`ov-day${isDragging ? ' dragging' : ''}`}
      {...attributes}
      {...listeners}
      onClick={() => dispatch({ type: 'select_day', dayId: day.id })}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') dispatch({ type: 'select_day', dayId: day.id }); }}
    >
      <div className="ph" style={{ background: PHASES[day.phase]?.color }} />
      <div className="dt">{day.dow}<br />{fmtDayDate(day.date)}{day.anchor ? ' ★' : ''}</div>
      <div>
        <div className="t">{tt(day.title)}</div>
      </div>
      <div className="m">
        {u.mi(per?.miles ?? day.miles)} · {(per ? per.rideHours + per.stopHours : day.hours).toFixed(0)}h
        {dangers > 0 && <div className="warn-inline">▲ {dangers}</div>}
      </div>
    </div>
  );
}

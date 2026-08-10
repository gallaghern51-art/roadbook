import React from 'react';
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTrip } from '../engine/store.js';
import { PHASES } from '../data/seedTrip.js';
import { fmtDayDate, fmtLongDate } from '../engine/dates.js';
import { useT, useTT, useUnits } from '../engine/settings.jsx';
import { uid } from '../engine/ops.js';
import { tripPace } from '../engine/tripEngine.js';

// Suggestions only — riders type whatever they actually ride. (The list began
// as the EagleRider rental lineup the Sturgis crew booked from; it survives as
// autocomplete, not as the universe of motorcycles.)
const BIKE_SUGGESTIONS = [
  'Street Glide', 'Street Glide Ultra', 'Road Glide', 'Road Glide Ultra',
  'Electra Glide', 'Road King', 'Heritage Softail Classic',
  'CVO Street Glide', 'CVO Road Glide', 'Pan America 1250',
  'BMW R 1300 GS', 'Honda Gold Wing', 'KTM 1290 Super Adventure', 'Indian Roadmaster',
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

      <TripSettings trip={trip} dispatch={dispatch} />

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

function TripSettings({ trip, dispatch }) {
  const t = useT();
  const set = (patch) => dispatch({ type: 'apply_ops', ops: [{ op: 'set_meta', patch }] });
  const range = { comfort: 180, absolute: 200, mpg: 45, ...(trip.meta.range ?? {}) };
  const setRange = (k, v) => set({ range: { ...range, [k]: Number(v) || 0 } });
  return (
    <div className="section">
      <h3>{t('Trip settings')}</h3>
      <div className="budget-grid">
        <label className="fld" style={{ gridColumn: 'span 2' }}>{t('Trip name')}
          <input defaultValue={trip.meta.title} key={trip.meta.title}
            onBlur={(e) => { if (e.target.value.trim() && e.target.value !== trip.meta.title) set({ title: e.target.value.trim() }); }} />
        </label>
        <label className="fld" style={{ gridColumn: '1 / -1' }}>{t('Trip summary')}
          <textarea rows={3} defaultValue={trip.meta.summary ?? ''} key={trip.meta.summary}
            onBlur={(e) => { if (e.target.value !== (trip.meta.summary ?? '')) set({ summary: e.target.value }); }} />
        </label>
        <label className="fld">{t('Start date')}
          <input type="date" value={trip.meta.startDate}
            onChange={(e) => { if (e.target.value) set({ startDate: e.target.value }); }} />
        </label>
        <label className="fld">{t('Riders')}
          <input type="number" min="1" value={trip.meta.riders}
            onChange={(e) => set({ riders: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label className="fld">{t('Range: comfort mi')}
          <input type="number" min="40" value={range.comfort} onChange={(e) => setRange('comfort', e.target.value)} />
        </label>
        <label className="fld">{t('Range: absolute mi')}
          <input type="number" min="50" value={range.absolute} onChange={(e) => setRange('absolute', e.target.value)} />
        </label>
        <label className="fld">MPG
          <input type="number" min="10" value={range.mpg} onChange={(e) => setRange('mpg', e.target.value)} />
        </label>
        <label className="fld">{t('Dusk (after-dark warnings)')}
          <input defaultValue={trip.meta.dusk ?? '8:30 PM'} key={trip.meta.dusk}
            placeholder="8:30 PM"
            onBlur={(e) => { if (e.target.value !== (trip.meta.dusk ?? '')) set({ dusk: e.target.value }); }} />
        </label>
        <label className="fld">{t('Group pace buffer %')}
          <input type="number" min="0" max="50" step="1"
            value={Math.round((tripPace(trip) - 1) * 100)}
            onChange={(e) => set({ pace: 1 + Math.max(0, Math.min(50, Number(e.target.value) || 0)) / 100 })} />
        </label>
        <label className="fld">{t('UTC offset (calendar export)')}
          <input type="number" min="-12" max="14" step="0.5" value={Number.isFinite(trip.meta.utcOffset) ? trip.meta.utcOffset : -6}
            onChange={(e) => set({ utcOffset: Number(e.target.value) })} />
        </label>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--ink-faint)', marginTop: 4 }}>
        {t('Changing the start date re-pins every day to the new calendar. Fuel warnings and feasibility use the bike range set here.')}{' '}
        {t('Dusk drives the after-dark warnings; the UTC offset places .ics calendar times in the trip’s zone.')}{' '}
        {t('The pace buffer slows every planned leg for group riding — set 0 for a solo trip, 15+ for a big group.')}
      </p>
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

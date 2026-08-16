import React, { useRef, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { dayTimeline, fmtTime, fmtDur, dwellFor } from '../engine/timeline.js';
import { PHASES } from '../data/seedTrip.js';
import { fmtDayDate } from '../engine/dates.js';
import { geocode } from '../engine/geocode.js';
import { useT, useTT, useUnits } from '../engine/settings.jsx';

export default function DetailModal() {
  const { state, dispatch, routedLegsByDay, ui } = useTrip();
  const { modal, trip } = state;
  if (!modal) return null;
  const day = trip.days.find((d) => d.id === modal.dayId);
  if (!day) return null;
  const close = () => dispatch({ type: 'close_modal' });

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {modal.type === 'stop'
          ? <StopDetail day={day} waypointId={modal.waypointId} trip={trip} dispatch={dispatch} routedLegsByDay={routedLegsByDay} close={close} />
          : <LegDetail day={day} legIndex={modal.legIndex} routedLegsByDay={routedLegsByDay} dispatch={dispatch} close={close} showPanel={ui?.showPanel} />}
      </div>
    </div>
  );
}

function StopDetail({ day, waypointId, trip, dispatch, routedLegsByDay, close }) {
  const w = day.waypoints.find((x) => x.id === waypointId);
  const [form, setForm] = useState(w ? { name: w.name, note: w.note ?? '', dwell: dwellFor(w), fuel: !!w.fuel, lat: w.lat, lng: w.lng } : null);
  const [places, setPlaces] = useState([]);
  const [searching, setSearching] = useState(false);
  const [moved, setMoved] = useState(false);
  const timer = useRef(null);
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  if (!w || !form) return <div className="modal-body">{t('This stop no longer exists.')}</div>;

  // Google-Maps-style: typing a place name geocodes live; picking a match
  // rewrites the stop's coordinates and moves it on the map.
  const onName = (text) => {
    setForm((f) => ({ ...f, name: text }));
    clearTimeout(timer.current);
    if (text.trim().length < 3) { setPlaces([]); return; }
    timer.current = setTimeout(async () => {
      setSearching(true);
      try { setPlaces(await geocode(text)); } catch { setPlaces([]); } finally { setSearching(false); }
    }, 400);
  };
  const pickPlace = (p) => {
    setForm((f) => ({ ...f, name: p.name, lat: p.lat, lng: p.lng, placeId: p.source === 'google' && p.id ? p.id : null }));
    setMoved(true);
    setPlaces([]);
  };
  const tl = dayTimeline(day, routedLegsByDay[day.id]);
  const idx = day.waypoints.indexOf(w);
  const s = tl.stops[idx];
  const phase = PHASES[day.phase];

  const save = () => {
    const patch = { name: form.name, note: form.note, dwell: Number(form.dwell) || 0, fuel: form.fuel };
    if (moved) {
      patch.lat = form.lat; patch.lng = form.lng; patch.mile = null; patch.placeId = form.placeId ?? null;
      // Picked from search → proved; typed in by hand → the stamp no longer
      // describes this coordinate, so it goes (ops.js clears it either way,
      // this is what re-earns it).
      patch.verified = form.placeId ? 'google' : null;
    }
    dispatch({ type: 'apply_ops', ops: [{ op: 'update_waypoint', dayId: day.id, waypointId: w.id, patch }] });
    close();
  };
  const moveTo = (toDayId) => {
    if (!toDayId || toDayId === day.id) return;
    dispatch({ type: 'apply_ops', ops: [{ op: 'move_waypoint', fromDayId: day.id, toDayId, waypointId: w.id }] });
    close();
  };
  const remove = () => {
    dispatch({ type: 'apply_ops', ops: [{ op: 'remove_waypoint', dayId: day.id, waypointId: w.id }] });
    close();
  };

  return (
    <>
      <div className="modal-head">
        <div>
          <div className="eyebrow">{day.dow} · <span style={{ color: phase?.color }}>{t(phase?.label)}</span> · {t('stop')} {idx + 1} {t('of')} {day.waypoints.length}</div>
          <h3>{tt(w.name)}</h3>
        </div>
        <button className="btn" onClick={close}>✕</button>
      </div>
      <div className="modal-body">
        <div className="time-strip">
          <div className="ts-cell"><div className="n">{s ? fmtTime(s.arrive) : '—'}</div><div className="l">{t('Arrive')}</div></div>
          <div className="ts-cell"><div className="n">{s ? fmtDur(s.dwell) : '—'}</div><div className="l">{t('On the ground')}</div></div>
          <div className="ts-cell"><div className="n">{s ? fmtTime(s.depart) : '—'}</div><div className="l">{t('Roll out')}</div></div>
          {idx > 0 && s && <div className="ts-cell"><div className="n">{u.mi(s.legMiles)} · {fmtDur(s.legMin)}</div><div className="l">{t('Leg in')}</div></div>}
        </div>
        <label className="fld" style={{ position: 'relative' }}>Location / name
          <input value={form.name} onChange={(e) => onName(e.target.value)} placeholder={t('Type any real place — e.g. Bozeman, MT')} />
          {searching && <div className="ps-status">{t('searching…')}</div>}
          {places.length > 0 && (
            <div className="ps-results">
              {places.map((p) => (
                <button key={p.id} type="button" onClick={() => pickPlace(p)}>
                  <span className="ps-name">{p.name}</span>
                  <span className="ps-detail">{p.detail}</span>
                </button>
              ))}
            </div>
          )}
        </label>
        {moved && <div className="feas-ok">{t('✓ Location updated →')} {form.lat.toFixed(4)}, {form.lng.toFixed(4)} {t('— route re-snaps on save')}</div>}
        <label className="fld">{t('Note')}<textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <div className="fld-row">
          <label className="fld">{t('Time here (min)')}<input type="number" min="0" step="5" value={form.dwell} onChange={(e) => setForm({ ...form, dwell: e.target.value })} /></label>
          <label className="fld chk"><input type="checkbox" checked={form.fuel} onChange={(e) => setForm({ ...form, fuel: e.target.checked })} /> {t('Fuel stop')}</label>
        </div>
        <div className="fld-row">
          <label className="fld">{t('Move to day')}
            <select defaultValue="" onChange={(e) => moveTo(e.target.value)}>
              <option value="" disabled>{t('Choose…')}</option>
              {trip.days.filter((d) => d.id !== day.id).map((d) => (
                <option key={d.id} value={d.id}>{d.dow} {fmtDayDate(d.date)} — {tt(d.title).slice(0, 34)}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="pp-note" style={{ marginTop: 6 }}>lat {w.lat.toFixed(4)}, lng {w.lng.toFixed(4)}{w.mile != null ? ` · field-guide mile ${w.mile}` : ''}</div>
      </div>
      <div className="modal-foot">
        <button className="btn danger-ghost" onClick={remove}>{t('Remove stop')}</button>
        <span className="foot-spacer" />
        <button className="btn" onClick={close}>{t('Cancel')}</button>
        <button className="btn gold" onClick={save}>{t('Save')}</button>
      </div>
    </>
  );
}

function LegDetail({ day, legIndex, routedLegsByDay, dispatch, close, showPanel }) {
  const from = day.waypoints[legIndex];
  const to = day.waypoints[legIndex + 1];
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  if (!from || !to) return <div className="modal-body">{t('This leg no longer exists.')}</div>;
  const tl = dayTimeline(day, routedLegsByDay[day.id]);
  const dep = tl.stops[legIndex];
  const arr = tl.stops[legIndex + 1];
  const phase = PHASES[day.phase];

  return (
    <>
      <div className="modal-head">
        <div>
          <div className="eyebrow">{day.dow} · <span style={{ color: phase?.color }}>{t(phase?.label)}</span> · {t('leg')} {legIndex + 1} {t('of')} {day.waypoints.length - 1}</div>
          <h3>{tt(from.name)} → {tt(to.name)}</h3>
        </div>
        <button className="btn" onClick={close}>✕</button>
      </div>
      <div className="modal-body">
        <div className="time-strip">
          <div className="ts-cell"><div className="n">{dep ? fmtTime(dep.depart) : '—'}</div><div className="l">Depart {shortN(from.name)}</div></div>
          <div className="ts-cell"><div className="n">{arr ? u.mi(arr.legMiles) : '—'}</div><div className="l">{t('Distance')}</div></div>
          <div className="ts-cell"><div className="n">{arr ? fmtDur(arr.legMin) : '—'}</div><div className="l">{t('Ride time')}</div></div>
          <div className="ts-cell"><div className="n">{arr ? fmtTime(arr.arrive) : '—'}</div><div className="l">Arrive {shortN(to.name)}</div></div>
        </div>
        {from.note && <div className="pp-note">{t('Start:')} {tt(from.note)}</div>}
        {to.note && <div className="pp-note">{t('End:')} {tt(to.note)}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={() => { dispatch({ type: 'select_day', dayId: day.id }); showPanel?.(); close(); }}>{t('Open this day')}</button>
        <span className="foot-spacer" />
        <button className="btn gold" onClick={close}>{t('Done')}</button>
      </div>
    </>
  );
}

const shortN = (n) => (n && n.length > 14 ? n.slice(0, 13) + '…' : n);

import React, { useState } from 'react';
import { useTrip } from '../engine/store.js';
import { blankDay, uid } from '../engine/ops.js';
import { cascadeDates } from '../engine/dates.js';
import { geocode } from '../engine/geocode.js';
import { SEED_TRIP } from '../data/seedTrip.js';
import { usePlacePreferences } from '../engine/placePreferences.js';
import TripConstructionChat from './TripConstructionChat.jsx';

const today = () => new Date().toISOString().slice(0, 10);

export default function NewTripModal({ onClose, onCreated, initial, account }) {
  const { dispatch } = useTrip();
  const [tab, setTab] = useState(initial?.tab ?? 'ai'); // ai | blank | template
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(today());
  const [numDays, setNumDays] = useState(5);
  const [riders, setRiders] = useState(2);
  const [startPlace, setStartPlace] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [aiStarted, setAiStarted] = useState(false);
  const [editBasics, setEditBasics] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false); // two-tap close while a build runs
  const placePreferences = usePlacePreferences(account);
  // Home hands off here after trip creation so the app can land in the workspace.
  const created = () => (onCreated ? onCreated() : onClose());

  // Closing mid-build throws the itinerary away — arm, then confirm (the
  // app's two-tap pattern, no window.confirm). The backdrop never closes a
  // running build; only an explicit second tap does.
  const requestClose = () => {
    if (!busy) { onClose(); return; }
    if (!confirmCancel) {
      setConfirmCancel(true);
      setTimeout(() => setConfirmCancel(false), 3000);
      return;
    }
    onClose();
  };

  const baseMeta = (title) => ({
    title: title || 'New trip',
    subtitle: 'Planned with the motorcycle trip planner',
    startDate,
    riders: Number(riders) || 1,
    nights: Math.max(0, Number(numDays) - 1),
    fuelRule: 'Fill at half tank on any stretch over 100 miles.',
    range: { comfort: 180, absolute: 200, mpg: 45 },
  });

  const createBlank = async () => {
    setBusy(true);
    setErr('');
    try {
      const days = Array.from({ length: Math.max(1, Number(numDays)) }, (_, i) => blankDay({ title: `Day ${i + 1}` }));
      if (startPlace.trim()) {
        const hits = await geocode(startPlace);
        if (hits[0]) {
          days[0].waypoints.push({ id: uid('w'), name: hits[0].name, lat: hits[0].lat, lng: hits[0].lng, kind: 'start', mile: 0, note: hits[0].detail });
        }
      }
      const trip = cascadeDates({ meta: baseMeta(name), days, reserveNow: [], fieldNotes: null });
      dispatch({ type: 'create_trip', trip });
      created();
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const createFromTemplate = () => {
    const trip = structuredClone(SEED_TRIP);
    if (name.trim()) trip.meta.title = name.trim();
    dispatch({ type: 'create_trip', trip });
    created();
  };

  const acceptAiTrip = async (data) => {
    setErr('');
    try {
      if (!data.trip?.days?.length) throw new Error('The builder returned an empty plan — try a more specific description.');
      // assign fresh ids + defaults, then pin dates
      const trip = {
        meta: { ...baseMeta(name), ...data.trip.meta },
        days: data.trip.days.map((d) => {
          // The model's gate waypointIndex counts its EMITTED array — resolve
          // ids against that same shape (invalid stops hold their slot as
          // null) so dropping a bad coordinate can't shift a gate onto the
          // next stop over.
          const emitted = (d.waypoints ?? []).map((w) => (
            Number.isFinite(w.lat) && Number.isFinite(w.lng)
              ? { id: uid('w'), kind: 'via', mile: null, note: '', ...w }
              : null
          ));
          const waypoints = emitted.filter(Boolean);
          // Day endpoints get their positional kinds when the model left them
          // as plain vias — overnights are the stops the trip map marks, and
          // an unkinded boundary rendered markerless. Deliberate fuel/photo
          // kinds at an endpoint are kept (marker logic is positional now).
          if (waypoints.length) {
            const first = waypoints[0], last = waypoints[waypoints.length - 1];
            if (first.kind === 'via') first.kind = 'start';
            if (last.kind === 'via' && waypoints.length > 1) last.kind = 'end';
          }
          const gates = (d.gates ?? [])
            .map((g) => ({ label: g.label, by: g.by, waypointId: emitted[g.waypointIndex]?.id ?? null }))
            .filter((g) => g.label && g.by);
          return {
            ...blankDay({}),
            ...d,
            id: uid('day'),
            waypoints,
            meals: d.meals ?? [],
            photos: [], modules: [], ops: [], constraints: d.constraints ?? [], gates,
            lodging: { status: 'none', name: '', where: '', note: '', ...(d.lodging ?? {}) },
          };
        }),
        reserveNow: [],
        fieldNotes: null,
      };
      cascadeDates(trip);
      dispatch({ type: 'create_trip', trip });
      created();
    } catch (e) {
      setErr(String(e.message || e));
      throw e;
    }
  };

  const basics = {
    name: name.trim(),
    startDate,
    numDays: Number(numDays),
    riders: Number(riders),
    pace: Number(riders) > 4 ? 1.15 : Number(riders) > 1 ? 1.08 : 1,
    range: { comfort: 180, absolute: 200 },
    routePrefs: { style: 'touring', avoidTolls: false },
  };

  const basicsFields = (
    <section className="builder-basics">
      <div className="builder-basics-copy">
        <h4>{aiStarted ? 'Trip details' : 'Set the frame'}</h4>
        <p>{aiStarted
          ? 'Changes here apply to the next planning turn and the final trip.'
          : 'Give Roadbook the fixed facts first. The conversation handles the route, stops, and tradeoffs next.'}</p>
      </div>
      <div className="builder-basics-grid">
        <label className="fld wide">Trip name<input value={name} placeholder="e.g. Blue Ridge Blast" onChange={(e) => setName(e.target.value)} /></label>
        <label className="fld">Start date<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
        <label className="fld">Days<input type="number" min="1" max="30" value={numDays} onChange={(e) => setNumDays(e.target.value)} /></label>
        <label className="fld">Riders<input type="number" min="1" max="30" value={riders} onChange={(e) => setRiders(e.target.value)} /></label>
        {aiStarted && <button className="btn basics-done" type="button" onClick={() => setEditBasics(false)}>Done</button>}
      </div>
    </section>
  );

  return (
    <div className={`modal-backdrop new-trip-backdrop${tab === 'ai' ? ' ai-builder' : ''}`} onClick={busy ? undefined : onClose}>
      <div className={`modal new-trip-modal${tab === 'ai' ? ' trip-builder' : ''}${aiStarted ? ' construction-active' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">{tab === 'ai' && aiStarted ? 'AI trip construction' : 'Trip library'}</div>
            <h3>{tab === 'ai' && aiStarted ? (name.trim() || 'Shape your ride') : 'New trip'}</h3>
          </div>
          <button className={`btn${confirmCancel ? ' danger-ghost' : ''}`} onClick={requestClose}>{confirmCancel ? 'Sure?' : '✕'}</button>
        </div>
        <div className="modal-body">
          <div className="tabbar">
            <button disabled={busy} className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>AI builder</button>
            <button disabled={busy} className={tab === 'blank' ? 'active' : ''} onClick={() => setTab('blank')}>Blank</button>
            <button disabled={busy} className={tab === 'template' ? 'active' : ''} onClick={() => setTab('template')}>Sturgis template</button>
          </div>

          {tab === 'ai' && (!aiStarted || editBasics) && basicsFields}

          {tab === 'ai' && aiStarted && !editBasics && (
            <div className="builder-context" aria-label="Trip details">
              <div>
                <span>{startDate}</span>
                <span>{numDays} {Number(numDays) === 1 ? 'day' : 'days'}</span>
                <span>{riders} {Number(riders) === 1 ? 'rider' : 'riders'}</span>
              </div>
              <button type="button" onClick={() => setEditBasics(true)}>Edit trip details</button>
            </div>
          )}

          {tab === 'blank' && (
            <>
            <div className="fld-row">
              <label className="fld">Trip name<input value={name} placeholder="e.g. Blue Ridge Blast" onChange={(e) => setName(e.target.value)} /></label>
              <label className="fld">Start date<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
            </div>
            <div className="fld-row">
              <label className="fld">Days<input type="number" min="1" max="30" value={numDays} onChange={(e) => setNumDays(e.target.value)} /></label>
              <label className="fld">Riders<input type="number" min="1" max="30" value={riders} onChange={(e) => setRiders(e.target.value)} /></label>
            </div>
            <label className="fld">Starting point (optional)
              <input value={startPlace} placeholder="e.g. Asheville, NC — geocoded automatically" onChange={(e) => setStartPlace(e.target.value)} />
            </label>
            </>
          )}

          <div className="ai-workspace" hidden={tab !== 'ai'}>
            <TripConstructionChat
              initialPrompt={initial?.prompt ?? ''}
              basics={basics}
              onTrip={acceptAiTrip}
              onBusyChange={setBusy}
              onStageChange={setAiStarted}
              placePreferences={placePreferences}
            />
          </div>
          {tab === 'template' && (
            <div className="template-create">
              <label className="fld">Trip name<input value={name} placeholder="STURGIS 2026 (copy)" onChange={(e) => setName(e.target.value)} /></label>
              <p>
              A full copy of the Sturgis 2026 field-guide trip — 11 days, every stop, gate, booking, and
              module — as a separate trip you can tear apart freely.
              </p>
            </div>
          )}

          {err && <div className="warning danger">⚠ {err}</div>}
        </div>
        {tab !== 'ai' && <div className="modal-foot">
          <span className="foot-note">
            {tab === 'ai' ? 'Research, compare, refine, then confirm.' : ''}
          </span>
          <button className={`btn${confirmCancel ? ' danger-ghost' : ''}`} onClick={requestClose}>{confirmCancel ? 'Sure?' : 'Cancel'}</button>
          {tab === 'blank' && <button className="btn gold" disabled={busy} onClick={createBlank}>{busy ? 'Creating…' : 'Create trip'}</button>}
          {tab === 'template' && <button className="btn gold" onClick={createFromTemplate}>Create from template</button>}
        </div>}
      </div>
    </div>
  );
}

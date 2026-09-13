import React, { useState } from 'react';
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTrip } from '../engine/store.js';
import { PHASES, phaseLabel } from '../data/seedTrip.js';
import { fmtLongDate } from '../engine/dates.js';
import { fuelGaps, haversineMiles, bestInsertIndex, insertIndexOnRoute, summaryIsStale } from '../engine/tripEngine.js';
import { dayTimeline, fmtTime, fmtDur, to24h, from24h, parseTime } from '../engine/timeline.js';
import NearbyPicker from './NearbyPicker.jsx';
import { Sheet } from './Sheets.jsx';
import { gateSlack } from '../engine/nearby.js';
import { tripRoutePrefs, alongOnRoute, tripRange } from '../engine/tripEngine.js';
import ConditionsCard from './ConditionsCard.jsx';
import { tripToGpx, downloadFile } from '../engine/exporters.js';
import { useT, useTT, useUnits, useSettings } from '../engine/settings.jsx';
import { dayRoadShields } from '../engine/roads.js';
import RoadShield from './RoadShield.jsx';
import { parksForDay } from '../data/parks.js';
import ScenarioStrip from './ScenarioStrip.jsx';

// Did the places database confirm this stop is the real thing?
// `verified` is written server-side by netlify/lib/verify-places.mjs after the
// AI proposes a station, property, or restaurant. Three states, and the third
// is the reason this is a component rather than a boolean: UNSTAMPED means
// nobody ever checked (seed trips, hand-built stops, a site with no places
// key) and must render nothing — flagging those would nag every rider about
// stops that were never in question.
function VerifyTag({ on, t }) {
  if (on === false) {
    return (
      <span className="tag unverified" title={t('The places database found no real business at this pin, so this stop is unconfirmed. Re-pick it with search before you ride.')}>
        ⚠ {t('unverified')}
      </span>
    );
  }
  if (on === 'google' || on === 'model') {
    return <span className="tag verified" title={t('Checked against the live places database — this is a real business at these coordinates.')}>✓</span>;
  }
  return null;
}

export default function DayPanel({ day }) {
  const { state, dispatch, summary, routedLegsByDay, routes } = useTrip();
  const per = summary.perDay.find((p) => p.id === day.id);
  const phase = PHASES[day.phase];
  // Mouse drags start immediately; touch drags wait out a short press so a
  // finger swipe over the list scrolls instead of reordering stops.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );
  const gaps = fuelGaps(day, routedLegsByDay[day.id]);
  const longestGap = gaps.reduce((m, g) => Math.max(m, g.miles), 0);
  const timeline = dayTimeline(day, routedLegsByDay[day.id]);
  const [swapId, setSwapId] = useState(null); // the stop row with the swap picker open
  const [dayMenu, setDayMenu] = useState(false); // the ⋯ sheet
  const [allPhases, setAllPhases] = useState(false);
  const usedPhases = new Set(state.trip.days.map((d) => d.phase).filter(Boolean));
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  const { shields: showShields } = useSettings();
  const shieldsByStop = dayRoadShields(day);
  const parks = parksForDay(day);
  // Running odometer per stop — leg miles come from the same timeline the ETAs use.
  const cumMiles = [];
  let acc = 0;
  for (const s of timeline.stops) { acc += s.legMiles; cumMiles.push(acc); }

  const onDragEnd = (e) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = day.waypoints.map((w) => w.id);
    const next = arrayMove(ids, ids.indexOf(active.id), ids.indexOf(over.id));
    dispatch({ type: 'apply_ops', ops: [{ op: 'reorder_waypoints', dayId: day.id, waypointIds: next }] });
  };

  return (
    <div>
      <div className="day-head">
        <div className="eyebrow">{day.dow} · {fmtLongDate(day.date)} · {t('Day')} {state.trip.days.indexOf(day) + 1} {t('of')} {state.trip.days.length}</div>
        <h2>{tt(day.title)}</h2>
        {/* The header carries what a rider reads at a glance — when we leave,
            when we arrive — and ONE more button. Phase, anchor, GPX, the two
            Copilot asks and the day's other verbs live behind ⋯: they are
            each used once a trip, and eight chips above the stops made the
            panel read as a control room rather than a day. */}
        <div className="datebar day-bar">
          <label className="chip depart-edit">{t('Depart')}
            {/* a real time field — the native picker beats typing "AM/PM" on
                a phone, and storage keeps the readable 12-hour string */}
            <input
              type="time"
              defaultValue={to24h(day.depart)}
              key={day.id + day.depart}
              onBlur={(e) => {
                const v = from24h(e.target.value);
                if (v && v !== day.depart) dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: day.id, field: 'depart', value: v }] });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
            />
          </label>
          <span className="chip">{t('End')} ~{fmtTime(timeline.endMin)}</span>
          <span className="chip phase-chip" style={{ '--seg-color': phase?.color }} title={t(phaseLabel(state.trip, day.phase))}>
            <i className="phase-dot" /> {t(phaseLabel(state.trip, day.phase))}{day.anchor ? ' ★' : ''}
          </span>
          <button className="chip day-more" aria-label={t('Day options')} title={t('Day options')} aria-haspopup="dialog" onClick={() => setDayMenu(true)}>⋯</button>
        </div>
        {dayMenu && (
          <Sheet eyebrow={`${day.dow} · ${fmtLongDate(day.date)}`} title={t('Day options')} onClose={() => setDayMenu(false)}>
            <div className="day-menu">
              <div className="dm-group">
                <span className="dm-label">{t('Phase')}</span>
                {/* Only the phases THIS trip has: an out-and-back offers
                    Outbound and Return, and never a destination day it does
                    not have. ＋ reveals the rest for the trip that grows one. */}
                <div className="dm-seg" role="radiogroup" aria-label={t('Phase')}>
                  {Object.entries(PHASES).filter(([k]) => allPhases || usedPhases.has(k)).map(([k, p]) => (
                    <button key={k} role="radio" aria-checked={day.phase === k} className={`phase-select${day.phase === k ? ' active' : ''}`} style={{ '--seg-color': p.color }}
                      onClick={() => dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: day.id, field: 'phase', value: k }] })}
                    ><i className="phase-dot" /> {t(phaseLabel(state.trip, k))}</button>
                  ))}
                  {!allPhases && usedPhases.size < Object.keys(PHASES).length && (
                    <button className="phase-select more" onClick={() => setAllPhases(true)} aria-label={t('More phases')}>＋ {t('More')}</button>
                  )}
                </div>
              </div>
              <button
                className={`dm-row anchor-toggle${day.anchor ? ' anchor' : ''}`}
                title={t('Anchor days are protected — the AI trims elsewhere first')}
                onClick={() => dispatch({ type: 'apply_ops', ops: [{ op: 'set_day_field', dayId: day.id, field: 'anchor', value: !day.anchor }] })}
              ><b>{day.anchor ? '★' : '☆'} {t('Anchor')}</b><small>{t('Anchor days are protected — the AI trims elsewhere first')}</small></button>
              {/* the AI's one door, reachable from the day it would be asked about */}
              <button className="dm-row ask-ai" onClick={() => { setDayMenu(false); dispatch({
                type: 'ask_optimizer',
                text: `${t('Review this day in detail — where is it tight, what breaks, and what would you change?')} (${day.dow} ${day.date} — ${day.title})`,
              }); }}><b>✦ {t('Ask Copilot')}</b><small>{t('Where this day is tight, what breaks, what to change')}</small></button>
              <button className="dm-row ask-ai" onClick={() => { setDayMenu(false); dispatch({
                type: 'ask_optimizer',
                text: `${t('Research this day as route-and-stop opportunities. Use verified places and Valhalla to compare 2–3 bundles of roads, fuel, food, lodging, and attractions. Show the measured time, distance, fuel-gap, and group trade-offs. Do not change the trip yet — let me choose or combine pieces first.')} (${day.dow} ${day.date} — ${day.title})`,
              }); }}><b>⌁ {t('Find route opportunities')}</b><small>{t('Compare 2–3 bundles of roads and stops, measured')}</small></button>
              <button
                className="dm-row gpx-btn"
                onClick={() => { setDayMenu(false); downloadFile(`trip-${day.date}-${day.dow.toLowerCase()}.gpx`, tripToGpx(state.trip, routes, routedLegsByDay, day.id), 'application/gpx+xml'); }}
              ><b>↓ {t('Download GPX')}</b><small>{t('This day as a route for a Garmin or another nav app')}</small></button>
            </div>
          </Sheet>
        )}
        {(day.phase === 'rally' || parks.length > 0) && (
          <div className="day-badges">
            {/* the rally patch belongs to the Sturgis trip, not to every trip
                that happens to use the 'rally' phase color */}
            {day.phase === 'rally' && /STURGIS/i.test(state.trip.meta.title) && (
              <img className="badge-thumb rally" src="/pics/sturgis-86.png" alt="Sturgis Rally 2026" title="Sturgis Motorcycle Rally 2026 · 86th" loading="lazy" />
            )}
            {parks.map((pk) => <ParkBadge key={pk.id} park={pk} label={t('National park')} />)}
          </div>
        )}
      </div>

      <ScenarioStrip compact />

      <div className="stat-row">
        <div className="stat"><div className="n">{u.miNum(per?.miles ?? day.miles)}</div><div className="l">{u.metric ? 'km' : t('Miles')}</div></div>
        <div className="stat"><div className="n">{per ? per.rideHours.toFixed(1) : day.hours}</div><div className="l">{t('Ride hrs')}</div></div>
        <div className="stat"><div className="n">{per ? per.stopHours.toFixed(1) : '—'}</div><div className="l">{t('Stop hrs')}</div></div>
        <div className="stat"><div className="n">{longestGap ? u.miNum(longestGap) : '—'}</div><div className="l">{t('Longest fuel gap')}{u.metric ? ' (km)' : ''}</div></div>
      </div>

      {per?.warnings.map((w, i) => (
        <div key={i} className={`warning${w.level === 'danger' ? ' danger' : ''}`}>⚠ {tt(w.text)}</div>
      ))}

      <DaySummary day={day} per={per} dispatch={dispatch} t={t} tt={tt} u={u} />

      {/* narrative notes — the GRADED mechanism is Hard gates below; two
          sections both claiming "hard" made the fake one look enforced */}
      {day.constraints?.length > 0 && (
        <div className="section">
          <h3>{t('Constraints')} <span className="cnt">{t('notes — the engine grades the Hard gates below')}</span></h3>
          <ul className="ops-list">{day.constraints.map((c, i) => <li key={i}>{tt(c)}</li>)}</ul>
        </div>
      )}

      <div className="section">
        <h3>{t('Route & stops')} <span className="cnt">{day.waypoints.length} · {t('drag ⠿ to reorder · tap to zoom the map · ⓘ for details')}</span></h3>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={day.waypoints.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {day.waypoints.map((w, i) => (
              <React.Fragment key={w.id}>
                <SortableWaypoint w={w} dayId={day.id} legIndex={i - 1} dispatch={dispatch} sched={timeline.stops[i]} cum={cumMiles[i]} first={i === 0} tt={tt} u={u} t={t} shields={showShields ? shieldsByStop[i] : null} snapM={routes[day.id]?.snaps?.[w.id]} onSwap={() => setSwapId(swapId === w.id ? null : w.id)} />
                {swapId === w.id && (
                  <SwapPicker day={day} w={w} sched={timeline.stops[i]} next={day.waypoints[i + 1] ?? null} dispatch={dispatch} routes={routes} trip={state.trip} onClose={() => setSwapId(null)} />
                )}
              </React.Fragment>
            ))}
          </SortableContext>
        </DndContext>
        <DayAddPicker day={day} dispatch={dispatch} routes={routes} timeline={timeline} trip={state.trip} />
      </div>

      <GatesSection day={day} dispatch={dispatch} timeline={timeline} t={t} tt={tt} />

      <ConditionsCard day={day} />

      <ModulesSection day={day} dispatch={dispatch} days={state.trip.days} />

      <MealsSection day={day} dispatch={dispatch} />

      <PhotoStops day={day} dispatch={dispatch} />

      <LodgingSection day={day} dispatch={dispatch} />

      {day.ops?.length > 0 && (
        <div className="section">
          <h3>{t('Operations')}</h3>
          <ul className="ops-list">{day.ops.map((o, i) => <li key={i}>{tt(o)}</li>)}</ul>
        </div>
      )}

      <div className="section" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <RemoveDayButton day={day} state={state} dispatch={dispatch} t={t} />
      </div>
    </div>
  );
}

// The day's description — prose about a route, and therefore the one output
// in this panel with no input until now: change the stops and the paragraph
// kept describing the ride you canceled (field-caught Aug 15, 2026, on the
// Beartooth day). Three doors, in the order a rider wants them: ask Copilot to
// rewrite it from the stops that are actually there, write it yourself, or say
// it still reads true — which re-stamps it against the current route and
// clears the flag. Unstamped days never nag; the flag only fires on drift the
// engine can prove (see routeFingerprint / summaryIsStale).
function DaySummary({ day, per, dispatch, t, tt, u }) {
  const [draft, setDraft] = useState(null); // non-null while editing
  const stale = summaryIsStale(day);
  const text = (day.summary ?? '').trim();
  const write = (value) => dispatch({
    type: 'apply_ops',
    ops: [{ op: 'set_day_field', dayId: day.id, field: 'summary', value }],
  });

  if (draft !== null) {
    return (
      <div className="day-summary editing">
        <textarea
          className="summary-edit"
          rows={8}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setDraft(null); }}
          placeholder={t('What this day is, and what it costs.')}
        />
        <div className="summary-acts">
          <button className="chip" onClick={() => { write(draft.trim()); setDraft(null); }}>{t('Save')}</button>
          <button className="chip ghost" onClick={() => setDraft(null)}>{t('Cancel')}</button>
        </div>
      </div>
    );
  }

  // The stop list and the engine's numbers ride along with the ask — the model
  // rewrites from the route that exists now, not from the paragraph it reads.
  const askRewrite = () => {
    const stops = day.waypoints.map((w) => w.name).filter(Boolean).join(' → ');
    const miles = u.mi(per?.miles ?? day.miles ?? 0);
    const hrs = per ? per.rideHours.toFixed(1) : day.hours;
    dispatch({
      type: 'ask_optimizer',
      text: `${t('Rewrite this day\'s description to match the route it actually has now — set_day_field summary, and the title too if the endpoints no longer match. One or two honest sentences in the field-guide voice, trade-offs included. Do not change the route.')}`
        + ` (${day.dow} ${day.date} — ${day.title}. ${t('Stops now')}: ${stops}. ${miles}, ${hrs} ${t('ride hrs')}.)`,
    });
  };

  return (
    <div className={`day-summary${stale ? ' stale' : ''}`}>
      {stale && (
        <div className="summary-flag">
          <div className="sf-head">⚠ {t('The route changed after this description was written.')}</div>
          <div className="summary-acts">
            <button className="chip ask-ai" onClick={askRewrite}>✦ {t('Rewrite with Copilot')}</button>
            <button className="chip" onClick={() => setDraft(day.summary ?? '')}>✎ {t('Edit')}</button>
            <button className="chip ghost" onClick={() => write(day.summary ?? '')}>{t('Still accurate')}</button>
          </div>
        </div>
      )}
      {text
        ? <p className="summary-text">{tt(day.summary)}</p>
        : <p className="summary-text empty">{t('No description for this day yet.')}</p>}
      {!stale && (
        <button className="summary-edit-link" onClick={() => setDraft(day.summary ?? '')}>
          ✎ {text ? t('Edit description') : t('Write a description')}
        </button>
      )}
    </div>
  );
}

// Two-tap remove — arms for 3 seconds, no window.confirm.
function RemoveDayButton({ day, state, dispatch, t }) {
  const [armed, setArmed] = useState(false);
  if (state.trip.days.length <= 1) return null;
  return (
    <button
      className="btn danger-ghost"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          setTimeout(() => setArmed(false), 3000);
          return;
        }
        dispatch({ type: 'select_day', dayId: null });
        dispatch({ type: 'apply_ops', ops: [{ op: 'remove_day', dayId: day.id }] });
      }}
    >{armed ? t('Sure? Later days shift earlier') : t('Remove this day')}</button>
  );
}

// The gates a day is graded against, editable in place. A gate is a promise —
// "be at the West Entrance booth by 7:00 AM" — so it names a stop and a time,
// and the row shows the live ETA against it so an edit answers itself.
function GatesSection({ day, dispatch, timeline, t, tt }) {
  const gates = day.gates ?? [];
  const stopName = (id) => day.waypoints.find((w) => w.id === id)?.name ?? '';
  const etaFor = (id) => {
    const i = day.waypoints.findIndex((w) => w.id === id);
    const s = timeline.stops[i];
    return s ? fmtTime(s.arrive) : null;
  };
  const patch = (index, p) => dispatch({ type: 'apply_ops', ops: [{ op: 'update_gate', dayId: day.id, index, patch: p }] });
  return (
    <div className="section">
      <h3>{t('Hard gates')} <span className="cnt">{t('be there by — feasibility grades against these')}</span></h3>
      {gates.map((g, i) => (
        <div key={i} className="gate-row">
          <input
            className="g-label"
            defaultValue={tt(g.label)}
            placeholder={t('What has to happen')}
            onBlur={(e) => { if (e.target.value !== g.label) patch(i, { label: e.target.value }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
          <input
            className="g-by"
            type="time"
            defaultValue={to24h(g.by)}
            key={`${i}:${g.by}`}
            onBlur={(e) => { const v = from24h(e.target.value); if (v && v !== g.by) patch(i, { by: v }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
          />
          {/* a gate pointing at a stop that no longer exists (data from before
              remove_waypoint pruned gates) surfaces loudly instead of
              half-rendering while silently absent from grading */}
          {(() => {
            const orphaned = g.waypointId && !day.waypoints.some((w) => w.id === g.waypointId);
            return (
              <select
                className={`g-stop${orphaned ? ' orphan' : ''}`}
                value={g.waypointId ?? ''}
                onChange={(e) => patch(i, { waypointId: e.target.value || null })}
              >
                <option value="">{t('at which stop…')}</option>
                {orphaned && <option value={g.waypointId}>{t('stop removed — re-point')}</option>}
                {day.waypoints.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            );
          })()}
          <span className="g-eta">{g.waypointId && etaFor(g.waypointId) ? `ETA ${etaFor(g.waypointId)}` : '—'}</span>
          <button
            className="mini-edit"
            title={t('Remove this gate')}
            onClick={() => dispatch({ type: 'apply_ops', ops: [{ op: 'remove_gate', dayId: day.id, index: i }] })}
          >✕</button>
        </div>
      ))}
      <button
        className="btn"
        style={{ fontSize: 11, padding: '3px 9px', marginTop: gates.length ? 6 : 0 }}
        onClick={() => dispatch({
          type: 'apply_ops',
          ops: [{ op: 'add_gate', dayId: day.id, gate: { label: t('New gate'), by: '9:00 AM', waypointId: day.waypoints[0]?.id ?? null } }],
        })}
      >＋ {t('Add gate')}</button>
    </div>
  );
}


// Park badge — the NPS arrowhead plus the park's name.
function ParkBadge({ park, label }) {
  return (
    <span className="park-badge" title={`${park.short} · ${label}`}>
      <img src="/pics/nps-arrowhead.png" alt="" aria-hidden="true" loading="lazy" />
      {park.short}
    </span>
  );
}

// Photo stops are read from the ROUTE — waypoints of kind 'photo' are the
// truth the map, timeline and Ride Mode already run on — enriched with the
// day's photo notes (why / best light / parking), matched by name or by
// proximity. Notes with no matching waypoint render as SUGGESTIONS with a
// one-tap add. Before this the section listed day.photos verbatim, which no
// edit ever touched: deleted photo stops kept their cards and added ones
// never appeared (owner-audited Aug 12, 2026).
function PhotoStops({ day, dispatch }) {
  const t = useT();
  const tt = useTT();
  const { routes } = useTrip();
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const metaFor = (w) => (day.photos ?? []).find((p) => {
    const a = norm(p.name);
    const b = norm(w.name);
    if (a && b && (a.includes(b) || b.includes(a))) return true;
    return Number.isFinite(p.lat) && Number.isFinite(p.lng) && haversineMiles(p, w) < 0.5;
  });
  const routed = day.waypoints.filter((w) => w.kind === 'photo').map((w) => ({ w, p: metaFor(w) }));
  const used = new Set(routed.map(({ p }) => p).filter(Boolean));
  const suggested = (day.photos ?? []).filter((p) => !used.has(p));
  if (!routed.length && !suggested.length) return null;
  const meta = (p) => (
    <div className="p-meta">
      {p.light && <div><b>{t('Best light')}</b> — {tt(p.light)}</div>}
      {p.parking && <div><b>{t('Parking')}</b> — {tt(p.parking)}</div>}
      {p.notes && <div><b>{t('Note')}</b> — {tt(p.notes)}</div>}
    </div>
  );
  return (
    <div className="section">
      <h3>{t('Photo stops')} <span className="cnt">{t('read from the route — suggestions add to it')}</span></h3>
      {routed.map(({ w, p }) => (
        <div key={w.id} className="photo-card">
          <div className="p-name">{tt(w.name)}</div>
          {(p?.why || w.note) && <div className="p-why">{tt(p?.why || w.note)}</div>}
          {p && meta(p)}
        </div>
      ))}
      {suggested.map((p, i) => (
        <div key={p.id ?? `s${i}`} className="photo-card suggested">
          <div className="p-name">{tt(p.name)} <span className="p-tag">{t('not on the route')}</span></div>
          {p.why && <div className="p-why">{tt(p.why)}</div>}
          {meta(p)}
          {Number.isFinite(p.lat) && Number.isFinite(p.lng) && (
            <button
              className="btn p-add"
              onClick={() => {
                // route order first (loop days), straight-line splice as fallback
                const geom = !routes[day.id]?.fallback ? routes[day.id]?.geometry : null;
                const chain = geom?.length > 1 ? geom.map(([lng, lat]) => ({ lat, lng })) : null;
                dispatch({
                  type: 'apply_ops',
                  ops: [{
                    op: 'add_waypoint',
                    dayId: day.id,
                    index: insertIndexOnRoute(day.waypoints, chain, p) ?? bestInsertIndex(day.waypoints, p),
                    waypoint: { name: p.name, lat: p.lat, lng: p.lng, kind: 'photo' },
                  }],
                });
              }}
            >＋ {t('Add to route')}</button>
          )}
        </div>
      ))}
    </div>
  );
}

const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'];


// ---- the picker's three doors on a day -----------------------------------
// The routed line for along-route mode; null when the day fell back to
// straight lines (there is no road to be "off" of then).
function dayChain(day, routes) {
  const r = routes?.[day.id];
  const geom = r && !r.fallback ? r.geometry : null;
  return geom?.length > 1 ? geom.map(([lng, lat]) => ({ lat, lng })) : null;
}
const dayDow = (day) => (day?.date ? new Date(`${day.date}T12:00:00`).getDay() : null);
// Where the day's fuel already is, along the routed line — the start and the
// end count as fuel marks (you leave full, you can fill on arrival).
function fuelMarks(day, chain, trip) {
  if (!chain) return null;
  const marks = [];
  day.waypoints.forEach((w, i) => {
    if (!(i === 0 || i === day.waypoints.length - 1 || w.fuel || w.kind === 'fuel')) return;
    const a = alongOnRoute(chain, { lat: w.lat, lng: w.lng })?.along;
    if (Number.isFinite(a)) marks.push(a);
  });
  return { comfortMi: tripRange(trip).comfort, marks };
}

function DayAddPicker({ day, dispatch, routes, timeline, trip }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const chain = dayChain(day, routes);
  const anchor = day.waypoints.find((w) => Number.isFinite(w.lat)) ?? null;
  if (!open) {
    return (
      <div className="place-search">
        <button className="btn" onClick={() => setOpen(true)}>＋ {t('Find a place — fuel, food, sights…')}</button>
      </div>
    );
  }
  const pick = (r, { fuel }) => {
    const pt = { lat: r.lat, lng: r.lng };
    dispatch({
      type: 'apply_ops',
      ops: [{
        op: 'add_waypoint',
        dayId: day.id,
        index: insertIndexOnRoute(day.waypoints, chain, pt) ?? bestInsertIndex(day.waypoints, pt),
        waypoint: {
          name: r.name, ...pt, kind: fuel ? 'fuel' : 'via', ...(fuel ? { fuel: true } : {}), note: r.detail ?? '',
          ...(r.source === 'google' && r.id ? { placeId: r.id, verified: 'google' } : {}),
        },
      }],
    });
    setOpen(false);
  };
  return (
    <NearbyPicker
      mode="add"
      near={anchor}
      chain={chain}
      fromAlong={0}
      dow={dayDow(day)}
      routePrefs={tripRoutePrefs(trip)}
      gateSlack={gateSlack(day, timeline, parseTime, null)}
      fuelPlan={fuelMarks(day, chain, trip)}
      onRows={(pins) => dispatch({ type: 'set_picker_pins', pins })}
      onPick={pick}
      onClose={() => setOpen(false)}
      title={t('Add a stop to this day')}
    />
  );
}

// Swap a stop: only the PLACE changes. Slot, kind, fuel flag, dwell and any
// gate pointing at this stop all stay — that is what makes it a swap and not
// a remove-and-add. The ETA the picker judges "open at" against is THIS
// stop's arrival in the simulated day.
function SwapPicker({ day, w, sched, next, dispatch, routes, trip, onClose }) {
  const t = useT();
  const { routedLegsByDay } = useTrip();
  const chain = dayChain(day, routes);
  const tl = dayTimeline(day, routedLegsByDay[day.id]);
  const idx = day.waypoints.findIndex((x) => x.id === w.id);
  const pick = (r) => {
    dispatch({
      type: 'apply_ops',
      ops: [{
        op: 'update_waypoint', dayId: day.id, waypointId: w.id,
        patch: {
          name: r.name, lat: r.lat, lng: r.lng, note: r.detail ?? w.note ?? '', mile: null,
          ...(r.source === 'google' && r.id ? { placeId: r.id, verified: 'google' } : { placeId: undefined }),
        },
      }],
    });
    onClose();
  };
  const cat = w.fuel || w.kind === 'fuel' ? 'fuel' : /diner|cafe|grill|restaurant|bar|kitchen|pizza|bbq/i.test(w.name) ? 'food' : null;
  // "ahead" and "behind" are relative to THIS stop's place on the line, not the
  // day's start — a candidate before it on the road is a candidate behind it.
  const here = chain ? alongOnRoute(chain, { lat: w.lat, lng: w.lng })?.along : null;
  return (
    <NearbyPicker
      mode="swap"
      near={{ lat: w.lat, lng: w.lng }}
      chain={chain}
      fromAlong={Number.isFinite(here) ? here : 0}
      nextStop={next && Number.isFinite(next.lat) ? { lat: next.lat, lng: next.lng } : null}
      etaMin={sched?.arrive ?? null}
      dow={dayDow(day)}
      routePrefs={tripRoutePrefs(trip)}
      gateSlack={gateSlack(day, tl, parseTime, idx)}
      fuelPlan={fuelMarks(day, chain, trip)}
      onRows={(pins) => dispatch({ type: 'set_picker_pins', pins })}
      initialCategory={cat}
      onPick={pick}
      onClose={onClose}
      title={`${t('Swap')} ${w.name}`}
    />
  );
}

// A meal has no coordinate of its own, so it is judged against the day's
// line and the hour the slot implies: breakfast at departure, lunch at 12:30,
// dinner at the day's end.
function MealSwapPicker({ day, meal, dispatch, onClose }) {
  const t = useT();
  const { routes, routedLegsByDay, state } = useTrip();
  const chain = dayChain(day, routes);
  const tl = dayTimeline(day, routedLegsByDay[day.id]);
  const mid = day.waypoints[Math.floor(day.waypoints.length / 2)] ?? day.waypoints[0];
  const eta = meal.meal === 'breakfast' ? tl.stops[0]?.depart : meal.meal === 'dinner' ? tl.endMin : 12 * 60 + 30;
  const pick = (r) => {
    dispatch({
      type: 'apply_ops',
      ops: [{
        op: 'update_meal', dayId: day.id, meal: meal.meal,
        patch: { name: r.name, where: r.detail ?? '', lat: r.lat, lng: r.lng, ...(r.source === 'google' && r.id ? { placeId: r.id, verified: 'google' } : {}) },
      }],
    });
    onClose();
  };
  return (
    <NearbyPicker
      mode="swap"
      near={mid && Number.isFinite(mid.lat) ? { lat: mid.lat, lng: mid.lng } : null}
      chain={chain}
      etaMin={Number.isFinite(eta) ? eta : null}
      dow={dayDow(day)}
      routePrefs={tripRoutePrefs(state.trip)}
      initialCategory={meal.meal === 'breakfast' ? 'coffee' : 'food'}
      onPick={pick}
      onClose={onClose}
      title={`${t('Swap')} ${t(meal.meal)}`}
    />
  );
}

function MealsSection({ day, dispatch }) {
  const [editing, setEditing] = useState(null); // meal slot being edited
  const [swapping, setSwapping] = useState(null); // meal slot with the swap picker open
  const [form, setForm] = useState({});
  const meals = day.meals ?? [];
  const missing = MEAL_SLOTS.filter((s) => !meals.some((m) => m.meal === s));
  const t = useT();
  const tt = useTT();

  const startEdit = (slot) => {
    const m = meals.find((x) => x.meal === slot) ?? { meal: slot, name: '', where: '', note: '', alt: '' };
    setForm(m);
    setEditing(slot);
  };
  const save = () => {
    dispatch({ type: 'apply_ops', ops: [{ op: 'update_meal', dayId: day.id, meal: editing, patch: { name: form.name, where: form.where, note: form.note, alt: form.alt } }] });
    setEditing(null);
  };

  return (
    <div className="section">
      <h3>{t('Food')} <span className="cnt">{t('click ✎ to edit')}</span></h3>
      {meals.map((m) => (
        <div key={m.meal} className="meal">
          {editing === m.meal ? (
            <MealForm form={form} setForm={setForm} save={save} cancel={() => setEditing(null)} />
          ) : (
            <>
              <div className="m-kind">{t(m.meal)}
                <button className="mini-edit" onClick={() => startEdit(m.meal)}>✎</button>
                <button className="mini-edit swap" title={t('Swap for another place')} aria-label={t('Swap for another place')} onClick={() => setSwapping(swapping === m.meal ? null : m.meal)}>⇄</button>
                <button className="mini-edit" title={t('Remove meal')} onClick={() => dispatch({ type: 'apply_ops', ops: [{ op: 'remove_meal', dayId: day.id, meal: m.meal }] })}>✕</button>
              </div>
              <div className="m-name">{m.name || '—'}<VerifyTag on={m.verified} t={t} /></div>
              {m.where && <div className="m-where">{m.where}</div>}
              {m.note && <div className="m-note">{tt(m.note)}</div>}
              {m.alt && <div className="m-alt">{tt(m.alt)}</div>}
              {swapping === m.meal && (
                <MealSwapPicker day={day} meal={m} dispatch={dispatch} onClose={() => setSwapping(null)} />
              )}
            </>
          )}
        </div>
      ))}
      {editing && !meals.some((m) => m.meal === editing) && (
        <div className="meal"><div className="m-kind">{t(editing)}</div><MealForm form={form} setForm={setForm} save={save} cancel={() => setEditing(null)} /></div>
      )}
      {missing.length > 0 && !editing && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {missing.map((s) => <button key={s} className="btn" style={{ fontSize: 11, padding: '3px 9px' }} onClick={() => startEdit(s)}>＋ {t(s)}</button>)}
        </div>
      )}
    </div>
  );
}

// Optional add-ons. The toggle is the common action, but the prose needs to be
// editable too: when an activity moves to another day, text still describing the
// old slot is worse than no text — so name/timing/reasoning are all editable,
// and a module can be relocated without losing its researched why/logistics.
const BLANK_MODULE = { name: '', duration: '', why: '', tradeoff: '', logistics: '' };

function ModulesSection({ day, dispatch, days }) {
  const t = useT();
  const tt = useTT();
  const [editing, setEditing] = useState(null); // module id, or '__new'
  const [form, setForm] = useState(BLANK_MODULE);
  const modules = day.modules ?? [];
  const elsewhere = days.filter((d) => d.id !== day.id);

  const apply = (ops) => dispatch({ type: 'apply_ops', ops });
  const startEdit = (m) => { setForm({ ...BLANK_MODULE, ...m }); setEditing(m.id); };
  const startNew = () => { setForm(BLANK_MODULE); setEditing('__new'); };

  const save = () => {
    const patch = {
      name: form.name, duration: form.duration,
      why: form.why, tradeoff: form.tradeoff, logistics: form.logistics,
    };
    if (editing === '__new') {
      if (!patch.name.trim()) return; // add_module rejects a nameless module
      apply([{ op: 'add_module', dayId: day.id, module: patch }]);
    } else {
      apply([{ op: 'update_module', dayId: day.id, moduleId: editing, patch }]);
    }
    setEditing(null);
  };

  if (!modules.length && editing !== '__new') {
    return (
      <div className="section">
        <h3>{t('Optional modules')}</h3>
        <button className="btn" style={{ fontSize: 11, padding: '3px 9px' }} onClick={startNew}>＋ {t('add an option')}</button>
      </div>
    );
  }

  return (
    <div className="section">
      <h3>{t('Optional modules')} <span className="cnt">{t('click ✎ to edit')}</span></h3>
      {modules.map((m) => (
        <div key={m.id} className={`module${m.enabled ? '' : ' off'}`}>
          {editing === m.id ? (
            <ModuleForm form={form} setForm={setForm} save={save} cancel={() => setEditing(null)} />
          ) : (
            <>
              <div className="mod-head">
                <span className="nm">{tt(m.name)}</span>
                <span className="mod-dur">{tt(m.duration)}</span>
                <button className="mini-edit" title="Edit this module" onClick={() => startEdit(m)}>✎</button>
                <button
                  className="mini-edit"
                  title="Remove this module"
                  onClick={() => apply([{ op: 'remove_module', dayId: day.id, moduleId: m.id }])}
                >✕</button>
                <button
                  className={`toggle${m.enabled ? ' on' : ''}`}
                  aria-label={`Toggle ${m.name}`}
                  onClick={() => apply([{ op: 'toggle_module', dayId: day.id, moduleId: m.id, enabled: !m.enabled }])}
                />
              </div>
              {m.why && <p><b>{t('Why:')}</b> {tt(m.why)}</p>}
              {m.tradeoff && <p><b>{t('Trade-off:')}</b> {tt(m.tradeoff)}</p>}
              {m.logistics && <p><b>{t('Logistics:')}</b> {tt(m.logistics)}</p>}
              {elsewhere.length > 0 && (
                <label className="mod-move">
                  {t('move to')}
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) apply([{ op: 'move_module', moduleId: m.id, fromDayId: day.id, toDayId: e.target.value }]);
                    }}
                  >
                    <option value="">{t('another day…')}</option>
                    {elsewhere.map((d) => (
                      <option key={d.id} value={d.id}>{d.dow} {d.date?.slice(5)} — {tt(d.title)}</option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      ))}
      {editing === '__new' && (
        <div className="module off">
          <ModuleForm form={form} setForm={setForm} save={save} cancel={() => setEditing(null)} isNew />
        </div>
      )}
      {!editing && (
        <button className="btn" style={{ fontSize: 11, padding: '3px 9px', marginTop: 6 }} onClick={startNew}>＋ {t('add an option')}</button>
      )}
    </div>
  );
}

function ModuleForm({ form, setForm, save, cancel, isNew }) {
  const t = useT();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <div>
      <div className="fld-row">
        <label className="fld">{t('Name')}<input value={form.name} onChange={set('name')} placeholder="e.g. Cody Firearms Museum" /></label>
        <label className="fld">{t('Timing')}<input value={form.duration} onChange={set('duration')} placeholder="e.g. 2 hrs, Sunday afternoon" /></label>
      </div>
      <label className="fld">{t('Why')}<textarea rows={2} value={form.why} onChange={set('why')} /></label>
      <label className="fld">{t('Trade-off')}<textarea rows={2} value={form.tradeoff} onChange={set('tradeoff')} /></label>
      <label className="fld">{t('Logistics')}<textarea rows={2} value={form.logistics} onChange={set('logistics')} /></label>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button className="btn gold" onClick={save} disabled={isNew && !form.name.trim()}>{isNew ? t('Add') : t('Save')}</button>
        <button className="btn" onClick={cancel}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function MealForm({ form, setForm, save, cancel }) {
  const t = useT();
  return (
    <div style={{ marginTop: 6 }}>
      <div className="fld-row">
        <label className="fld">{t('Spot')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="fld">{t('Where')}<input value={form.where} onChange={(e) => setForm({ ...form, where: e.target.value })} /></label>
      </div>
      <label className="fld">{t('Note')}<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn gold" onClick={save}>{t('Save')}</button>
        <button className="btn" onClick={cancel}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function LodgingSection({ day, dispatch }) {
  const [editing, setEditing] = useState(false);
  const lodging = day.lodging ?? { status: 'none', name: '', where: '', note: '' };
  const [form, setForm] = useState(lodging);
  const t = useT();
  const tt = useTT();

  const save = () => {
    dispatch({ type: 'apply_ops', ops: [{ op: 'update_lodging', dayId: day.id, patch: form }] });
    setEditing(false);
  };

  return (
    <div className="section">
      <h3>{t('Tonight')} <span className="cnt">{t('lodging')}</span></h3>
      {!editing ? (
        <div className={`lodging ${lodging.status}`}>
          <div className="l-status">
            {lodging.status === 'booked' ? t('● Confirmed booking') : lodging.status === 'reserve' ? t('▲ Not yet booked — reserve now') : t('○ No lodging set')}
            <button className="mini-edit" onClick={() => { setForm(lodging); setEditing(true); }}>{t('✎ edit')}</button>
          </div>
          <div className="l-name">{tt(lodging.name) || t('Nothing planned yet')}{lodging.name ? <VerifyTag on={lodging.verified} t={t} /> : null}</div>
          {lodging.where && <div className="l-where">{lodging.where}</div>}
          {lodging.note && <div className="l-note">{tt(lodging.note)}</div>}
        </div>
      ) : (
        <div className="lodging">
          <div className="fld-row">
            <label className="fld">{t('Property / plan')}<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="fld">{t('Status')}
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="none">{t('none')}</option>
                <option value="reserve">{t('needs booking')}</option>
                <option value="booked">{t('booked')}</option>
              </select>
            </label>
          </div>
          <label className="fld">{t('Address / town')}<input value={form.where} onChange={(e) => setForm({ ...form, where: e.target.value })} /></label>
          <label className="fld">{t('Note')}<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn gold" onClick={save}>{t('Save')}</button>
            <button className="btn" onClick={() => setEditing(false)}>{t('Cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableWaypoint({ w, dayId, legIndex, dispatch, sched, cum, first, tt, u, t, shields, snapM, onSwap}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`wp-row${isDragging ? ' dragging' : ''}`}
      // hovering a stop lights its arriving leg on the map — the row's +mi/+time
      // figures ARE that leg, so the map shows what the numbers describe.
      // Hover-capable pointers only: on touch, a tap's synthetic hover would
      // leave the highlight stuck with no mouseleave to ever clear it.
      onMouseEnter={() => { if (!first && legIndex >= 0 && window.matchMedia?.('(hover: hover)').matches) dispatch({ type: 'focus_leg', leg: { dayId, index: legIndex } }); }}
      onMouseLeave={() => { if (!first && legIndex >= 0 && window.matchMedia?.('(hover: hover)').matches) dispatch({ type: 'focus_leg', leg: null }); }}
    >
      <span className="grip" {...attributes} {...listeners}>⠿</span>
      <span
        className={`eta${!first && legIndex >= 0 ? ' leg-tap' : ''}`}
        title={!first && legIndex >= 0 ? t('Show this leg on the map') : undefined}
        role={!first && legIndex >= 0 ? 'button' : undefined}
        // TAP is the leg highlight on a phone (hover doesn't exist there, and
        // the panel covers the map anyway): the map zooms to the leg and the
        // panel steps aside — App closes it when a zoom-tagged focus arrives
        onClick={() => {
          if (!first && legIndex >= 0) dispatch({ type: 'focus_leg', leg: { dayId, index: legIndex, zoom: Date.now() } });
        }}
      >
        {sched ? fmtTime(first ? sched.depart : sched.arrive) : '·'}
        {!first && sched && sched.legMin > 0 && <span className="leg-t">+{fmtDur(sched.legMin)}</span>}
        {/* interval distance since the last stop, then the day's running odometer */}
        {!first && sched && sched.legMiles > 0 && (
          <span className="leg-mi">+{u.miNum(sched.legMiles)} {u.miUnit} · {u.miNum(cum)}</span>
        )}
        {shields?.length > 0 && (
          <span className="leg-roads">
            {shields.map((r) => <RoadShield key={r.key} road={r} />)}
          </span>
        )}
      </span>
      <div className="wp-main">
        <span
          className="nm clickable"
          title="Center the map on this stop"
          onClick={() => {
            if (Number.isFinite(w.lat) && Number.isFinite(w.lng)) dispatch({ type: 'focus_point', lat: w.lat, lng: w.lng });
          }}
        >
          {tt(w.name)}
          {w.fuel && <span className="tag fuel">FUEL</span>}
          {w.kind === 'photo' && <span className="tag photo">{t('Photo').toUpperCase()}</span>}
          {sched && sched.dwell > 0 && <span className="tag dwell">{fmtDur(sched.dwell)}</span>}
          {/* pin sits far from the road network — the router detours to touch
              it, which is what draws those double-back spurs on the map */}
          {snapM > 150 && (
            <span className="tag offroad" title={t('This pin sits off the road network, so routing detours to reach it. Drag it onto the road or re-pick the stop via search.')}>
              ⚠ {snapM} m {t('off road')}
            </span>
          )}
          <VerifyTag on={w.verified} t={t} />
        </span>
        {w.note && <span className="note">{tt(w.note)}</span>}
      </div>
      {/* Swap keeps the stop's ROLE — slot, kind, dwell, gates — and changes only
          the place. It is how "not that diner" becomes a two-tap fix instead of
          remove + search + re-add + re-dwell. */}
      {!first && onSwap && (
        <button className="rm swap" title={t('Swap this stop for another place')} aria-label={t('Swap this stop for another place')} onClick={onSwap}>⇄</button>
      )}
      <button
        className="rm info"
        title="Stop details"
        onClick={() => dispatch({ type: 'open_modal', modal: { type: 'stop', dayId, waypointId: w.id } })}
      >ⓘ</button>
      <button
        className="rm"
        title="Remove stop"
        onClick={() => dispatch({ type: 'apply_ops', ops: [{ op: 'remove_waypoint', dayId, waypointId: w.id }] })}
      >✕</button>
    </div>
  );
}

import React from 'react';
import { useTrip } from '../engine/store.js';
import { tripFeasibility } from '../engine/timeline.js';
import { fmtLongDate } from '../engine/dates.js';
import { tripToGpx, tripToIcs, downloadFile } from '../engine/exporters.js';
import { ROAD_STATUS_LINKS } from '../engine/conditions.js';
import FeasibilityPanel from './FeasibilityPanel.jsx';
import BudgetPanel, { budgetEstimate } from './BudgetPanel.jsx';
import PackingList, { packingProgress } from './PackingList.jsx';
import CrewPanel from './CrewPanel.jsx';
import { useT, useTT } from '../engine/settings.jsx';

// PREP — the trip's status board for the weeks before departure. No map: this
// is the surface you check with coffee, not the one you plan routes on. Every
// card is a status that deep-links to its owning view; the grade is the hero
// because "will this plan hold?" is the question the weeks-before ask.

function Card({ onClick, label, meta, note, accent }) {
  return (
    <button className={`dash-card${accent ? ` ${accent}` : ''}`} onClick={onClick}>
      <span className="dc-label">{label}</span>
      {meta && <span className="dc-meta">{meta}</span>}
      {note && <span className="dc-note">{note}</span>}
    </button>
  );
}

function BookingsList() {
  const { state, dispatch } = useTrip();
  const t = useT();
  const tt = useTT();
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState({ name: '', when: '', where: '', note: '' });
  const items = state.trip.reserveNow ?? [];
  const add = () => {
    if (!draft.name.trim()) return;
    dispatch({ type: 'apply_ops', ops: [{ op: 'add_reservation', reservation: { ...draft, name: draft.name.trim() } }] });
    setDraft({ name: '', when: '', where: '', note: '' });
    setAdding(false);
  };
  return (
    <div className="section">
      <h3>{t('Reserve these now')} <span className="cnt">{items.filter((r) => !r.done).length} {t('open')}</span></h3>
      {items.length === 0 && <p className="prep-empty">{t('Nothing on the checklist yet — add the calls this trip depends on.')}</p>}
      {items.map((r) => (
        <label key={r.id} className={`reserve-item${r.done ? ' done' : ''}`}>
          <input
            type="checkbox"
            checked={r.done}
            onChange={(e) => dispatch({ type: 'apply_ops', ops: [{ op: 'set_reservation_done', reservationId: r.id, done: e.target.checked }] })}
          />
          <div>
            <div className="r-name">{r.name}</div>
            <div className="r-when">{tt(r.when)}</div>
            <div className="r-note">{r.where}</div>
            <div className="r-note">{tt(r.note)}</div>
          </div>
          <button
            className="mini-edit r-del"
            title={t('Remove this booking')}
            onClick={(e) => { e.preventDefault(); dispatch({ type: 'apply_ops', ops: [{ op: 'remove_reservation', reservationId: r.id }] }); }}
          >✕</button>
        </label>
      ))}
      {adding ? (
        <div className="booking-add">
          <input autoFocus placeholder={t('What to book — hotel, table, tickets')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder={t('For when — “Night of Fri Aug 14”')} value={draft.when} onChange={(e) => setDraft({ ...draft, when: e.target.value })} />
          <input placeholder={t('Where / phone')} value={draft.where} onChange={(e) => setDraft({ ...draft, where: e.target.value })} />
          <input placeholder={t('Notes — backups, what to ask for')} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
          <div className="ba-actions">
            <button className="btn" onClick={() => setAdding(false)}>{t('Cancel')}</button>
            <button className="btn gold" disabled={!draft.name.trim()} onClick={add}>{t('Add booking')}</button>
          </div>
        </div>
      ) : (
        <button className="btn" style={{ marginTop: 8 }} onClick={() => setAdding(true)}>＋ {t('Add booking')}</button>
      )}
    </div>
  );
}

function FileView({ onExportJson, onImportJson, onReset }) {
  const { state, routes, routedLegsByDay } = useTrip();
  const { trip } = state;
  const t = useT();
  return (
    <div className="section">
      <h3>{t('Trip file')}</h3>
      <div className="dash-grid">
        <Card label={t('Export')} note={t('Save this trip as JSON')} onClick={onExportJson} />
        <Card label={t('Import')} note={t('Load a trip from JSON')} onClick={onImportJson} />
        <Card label={t('GPX — full trip')} note={t('Every day, one file, ETAs on the waypoints')} onClick={() => downloadFile('trip-full.gpx', tripToGpx(trip, routes, routedLegsByDay), 'application/gpx+xml')} />
        <Card label={t('Calendar (.ics)')} note={t('Departures, gates, dinners on every phone')} onClick={() => downloadFile('trip-calendar.ics', tripToIcs(trip, routedLegsByDay), 'text/calendar')} />
        <Card label={t('Reset')} note={t('Back to the bundled template')} accent="danger" onClick={onReset} />
      </div>
      <p className="prep-filenote">
        {t('GPX loads into Garmin, Rever, or any nav app (per-day GPX is on each day panel).')}
      </p>
    </div>
  );
}

export default function PrepBoard({ focus, setFocus, onAskAI, onSaveScenario, onExportJson, onImportJson, onReset }) {
  const { state, routedLegsByDay, collab } = useTrip();
  const { trip, scenarios } = state;
  const t = useT();
  const tt = useTT();

  const feas = tripFeasibility(trip, routedLegsByDay);
  const dangerDays = feas.perDay.filter((p) => p.issues.some((i) => i.level === 'fail')).length;
  const pack = packingProgress();
  const openBookings = (trip.reserveNow ?? []).filter((r) => !r.done).length;

  // Countdown: the one fact the masthead does not carry.
  const first = trip.days[0]?.date ?? trip.meta.startDate;
  const last = trip.days[trip.days.length - 1]?.date ?? trip.meta.startDate;
  const start = new Date(`${first}T00:00:00`);
  const end = new Date(`${last}T23:59:59`);
  const now = new Date();
  const countdown = now < start
    ? `T−${Math.ceil((start - now) / 86400000)} ${t('days')}`
    : now <= end
      ? `${t('Day')} ${Math.min(trip.days.length, Math.floor((now - start) / 86400000) + 1)} ${t('of')} ${trip.days.length}`
      : t('Ridden');

  if (focus) {
    return (
      <div className="prep-focus">
        <button className="btn back" onClick={() => setFocus(null)}>‹ {t('Prep board')}</button>
        {focus === 'feasibility' && <FeasibilityPanel />}
        {focus === 'budget' && <BudgetPanel />}
        {focus === 'packing' && <PackingList />}
        {focus === 'bookings' && <BookingsList />}
        {focus === 'crew' && <CrewPanel />}
        {focus === 'file' && <FileView onExportJson={onExportJson} onImportJson={onImportJson} onReset={onReset} />}
      </div>
    );
  }

  // Top issues across the trip — fails first, then warns, each pinned to its day.
  const topIssues = [];
  for (const level of ['fail', 'warn']) {
    for (const d of trip.days) {
      const p = feas.perDay.find((x) => x.id === d.id);
      for (const i of p.issues.filter((x) => x.level === level)) {
        topIssues.push({ day: d, issue: i });
      }
    }
  }

  return (
    <div className="prep-board">
      <div className="day-head">
        <div className="eyebrow">{tt(trip.meta.subtitle)}</div>
        <h2>{t('Prep board')}</h2>
        <div className="datebar">
          <span className="chip">{trip.days[0]?.dow} {fmtLongDate(first)} → {trip.days[trip.days.length - 1]?.dow} {fmtLongDate(last)}</span>
          <span className="chip anchor">{countdown}</span>
        </div>
      </div>

      <div className="prep-hero">
        <div className={`ph-grade grade grade-${feas.grade}`}>{feas.grade}</div>
        <div className="ph-main">
          <div className="ph-score">{feas.overall}/100{dangerDays ? ` · ${dangerDays} ${t('days need attention')}` : ` · ${t('the plan holds')}`}</div>
          <ul className="ph-issues">
            {topIssues.slice(0, 4).map(({ day, issue }, i) => (
              <li key={i} className={issue.level}>
                <b>{day.dow}</b> {tt(issue.text)}
              </li>
            ))}
            {topIssues.length === 0 && <li className="ok">{t('No gate, fuel, or daylight issues anywhere in the plan.')}</li>}
          </ul>
          <div className="ph-actions">
            <button className="btn" onClick={() => setFocus('feasibility')}>{t('Full feasibility study')} →</button>
            {dangerDays > 0 && (
              <button
                className="btn gold"
                onClick={() => onAskAI(t('Fix every failing day in this plan — retime departures, move stops to neighboring days, or trim — keep the anchor days intact, and save the result as a scenario.'))}
              >{t('Ask the AI to fix it')}</button>
            )}
          </div>
        </div>
      </div>

      <div className="section">
        <h3>{t('Status')}</h3>
        <div className="dash-grid">
          <Card
            label={t('Crew')}
            meta={collab?.crew
              ? `${collab.crew.members.length} ${t('joined')} · ${t(collab.crew.status === 'draft' ? 'DRAFT' : collab.crew.status === 'review' ? 'VOTING' : 'PUBLISHED')}`
              : collab?.info ? t('shared') : undefined}
            note={collab?.info ? t('Proposals, votes, recommendations') : t('Invite riders — plan it together')}
            accent={collab?.crew?.status === 'review' ? 'accent' : undefined}
            onClick={() => setFocus('crew')}
          />
          <Card
            label={t('Bookings')}
            meta={`${openBookings} ${t('open')}`}
            note={t('Reserve these now')}
            accent={openBookings > 0 ? 'warn' : undefined}
            onClick={() => setFocus('bookings')}
          />
          <Card
            label={t('Budget & fuel')}
            meta={`≈ $${budgetEstimate(trip, routedLegsByDay).toLocaleString()} / ${t('rider')}`}
            note={t('Fuel from routed miles · everything else adjustable')}
            onClick={() => setFocus('budget')}
          />
          <Card
            label={t('Packing list')}
            meta={`${pack.done}/${pack.total} ${t('packed')}`}
            onClick={() => setFocus('packing')}
          />
          <Card
            label={t('Plans')}
            meta={scenarios.length ? `${scenarios.length} ${t('saved')}` : undefined}
            note={t('Compare and load saved plans — save new ones from the Plans strip')}
            onClick={() => setFocus('feasibility')}
          />
          <Card
            label={t('Trip file')}
            note={t('Export, import, GPX, calendar, reset')}
            onClick={() => setFocus('file')}
          />
        </div>
      </div>

      {/* Agency links are region facts, not app facts: a trip carries its own
          (trip.roadLinks); the bundled list belongs to the Sturgis region. */}
      {(trip.roadLinks ?? (/STURGIS/i.test(trip.meta.title) ? ROAD_STATUS_LINKS : [])).length > 0 && (
        <div className="section">
          <h3>{t('Road status & smoke')} <span className="cnt">{t('check the week of')}</span></h3>
          <ul className="road-links">
            {(trip.roadLinks ?? ROAD_STATUS_LINKS).map((l) => (
              <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.name} ↗</a></li>
            ))}
          </ul>
        </div>
      )}

      {trip.meta.summary && <p className="trip-summary">{tt(trip.meta.summary)}</p>}
    </div>
  );
}

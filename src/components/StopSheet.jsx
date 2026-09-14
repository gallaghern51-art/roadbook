import React from 'react';
import PlaceSheet from './PlaceSheet.jsx';
import { VerifyTag } from './DayPanel.jsx';
import { dayTimeline, fmtTime, fmtDur } from '../engine/timeline.js';
import { phaseLabel } from '../data/seedTrip.js';
import { coordLabel } from '../engine/places.js';
import { useT, useTT, useUnits } from '../engine/settings.jsx';

// A STOP's card — tapped on the plan map (owner, Sep 13 2026: "tapping a
// stop marker opens that stop's card… ETA from the timeline, the leg miles,
// its verified/placed tag — instead of only a hover tooltip"). The surface
// is PlaceSheet, Roadbook's own place page: a verified stop fetches its
// photo, rating and hours by placeId the way a tapped POI does; a placed
// pin or an unverified one gets the plain sheet. What Google cannot know
// rides in `facts`: the day's schedule at this stop (arrive · on the ground
// · roll out · the leg in) and the honest tag. Editing stays where it was —
// the stop editor is one tap away — so nothing was taken away.
//
//   day, waypoint     the stop, on its day
//   trip              for the phase label
//   routedLegs        routedLegsByDay[day.id] — the timeline's input
//   onEdit()          open the stop editor (DetailModal 'stop')
//   onClose()
const GLYPH = { fuel: '⛽', photo: '📷', start: '🏁', end: '🏁' };

export default function StopSheet({ day, waypoint: w, trip, routedLegs, onEdit, onClose }) {
  const t = useT();
  const tt = useTT();
  const u = useUnits();
  const tl = dayTimeline(day, routedLegs);
  const idx = day.waypoints.indexOf(w);
  const s = tl.stops[idx];
  const glyph = w.fuel ? GLYPH.fuel : (GLYPH[w.kind] ?? '📍');
  // the address is Google's (details fill it in); the note is the rider's and rides in the facts
  const place = { name: tt(w.name), lat: w.lat, lng: w.lng, detail: '', ...(w.placeId && w.verified !== false ? { placeId: w.placeId } : {}) };
  // "stop 1 of 7" counts THIS day's stops — the card names the day it counts
  // in (Day 1 · Thu), because a phase like Return spans several days and
  // "Return · stop 1 of 7" beside "Return · stop 1 of 8" read as a mismatch
  const dayNo = trip.days.indexOf(day) + 1;
  const kicker = `${t('Day')} ${dayNo} · ${day.dow} · ${t(phaseLabel(trip, day.phase))} · ${t('stop')} ${idx + 1} ${t('of')} ${day.waypoints.length}`;
  return (
    <PlaceSheet
      place={place}
      glyph={glyph}
      kicker={kicker}
      note={w.verified === false ? t('The places database found no real business at this pin, so this stop is unconfirmed. Re-pick it with search before you ride.') : null}
      facts={(
        <div className="ss-facts">
          <div className="ss-tags">
            <VerifyTag on={w.verified} placed={w.placed} t={t} />
            {w.fuel && <span className="tag fuel-tag">⛽ {t('Fuel stop')}</span>}
            {!w.placeId && <span className="mono ss-coord">{coordLabel(w)}</span>}
          </div>
          {w.note && <p className="ss-note">{tt(w.note)}</p>}
          <div className="time-strip ss-strip">
            <div className="ts-cell"><div className="n">{s ? fmtTime(s.arrive) : '—'}</div><div className="l">{t('Arrive')}</div></div>
            <div className="ts-cell"><div className="n">{s ? fmtDur(s.dwell) : '—'}</div><div className="l">{t('On the ground')}</div></div>
            <div className="ts-cell"><div className="n">{s ? fmtTime(s.depart) : '—'}</div><div className="l">{t('Roll out')}</div></div>
            {idx > 0 && s && <div className="ts-cell"><div className="n">{u.mi(s.legMiles)} · {fmtDur(s.legMin)}</div><div className="l">{t('Leg in')}</div></div>}
          </div>
        </div>
      )}
      onClose={onClose}
      actions={(
        <>
          <button className="btn gold" onClick={onEdit}>✎ {t('Edit stop')}</button>
          <button className="btn" onClick={onClose}>{t('Close')}</button>
        </>
      )}
    />
  );
}

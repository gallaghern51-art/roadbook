import React, { useEffect, useRef } from 'react';
import { useTrip } from '../engine/store.js';
import { PHASES } from '../data/seedTrip.js';
import { fmtDayDate } from '../engine/dates.js';
import { gradeFor } from '../engine/timeline.js';
import { useT, useTT } from '../engine/settings.jsx';

// The day strip is an INDEX, not an overview: its first job is showing the
// WHOLE trip at once. The old 140px cards spent their width on titles that
// truncated into noise while eleven days scrolled mostly off a phone screen.
// These chips carry exactly what an index needs — weekday, date, phase color,
// grade, anchor — so a whole rally trip fits one phone-width row and the
// trip's shape (phases, trouble days) reads at a glance. Detail lives where
// it always did: the overview list and the day panel.

export default function Ribbon() {
  const { state, dispatch, feas } = useTrip();
  const { trip, selectedDayId } = state;
  const ref = useRef(null);
  const t = useT();
  const tt = useTT();

  // Long tours can still overflow — keep the selected chip in view.
  useEffect(() => {
    const el = ref.current?.querySelector('.rchip.active');
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedDayId]);

  // During the trip, today's chip is findable at a glance (same dashed ring
  // as the ride sheet's day chips — one convention for "today").
  const today = new Date().toLocaleDateString('sv-SE');

  return (
    <nav className="ribbon" aria-label="Trip days" ref={ref}>
      <button
        className={`rchip trip-seat${selectedDayId === null ? ' active' : ''}`}
        onClick={() => dispatch({ type: 'select_day', dayId: null })}
      >
        {t('Trip')}
      </button>
      {trip.days.map((d, i) => {
        const g = feas ? gradeFor(feas.perDay.find((p) => p.id === d.id)?.score ?? 100) : null;
        const color = PHASES[d.phase]?.color ?? '#888888';
        const date = fmtDayDate(d.date);
        const slash = date.indexOf('/');
        // A ridden day goes quiet: dimmed, no grade dot (grades are calls to
        // action, and yesterday takes no action) — still tappable to review.
        const past = !!d.date && d.date < today;
        return (
          <button
            key={d.id}
            className={`rchip${selectedDayId === d.id ? ' active' : ''}${d.date === today ? ' today' : ''}${past ? ' past' : ''}`}
            style={{ '--seg-color': color }}
            onClick={() => dispatch({ type: 'select_day', dayId: d.id })}
            title={`D${i + 1} · ${d.dow} ${date} — ${tt(d.title)}`}
          >
            <i className="rc-dow">
              <span className="rc-dow-full">{d.dow}</span>
              <span className="rc-dow-1">{(d.dow || '·')[0]}</span>
              {d.anchor ? ' ★' : ''}
            </i>
            <b className="rc-date">
              {/* the month goes quiet on a phone — the strip reads like a calendar */}
              {slash > 0 ? <><span className="rc-mo">{date.slice(0, slash + 1)}</span>{date.slice(slash + 1)}</> : date}
            </b>
            {g && g !== 'A' && !past && <span className={`rc-g grade-${g}`} aria-label={g} />}
          </button>
        );
      })}
    </nav>
  );
}

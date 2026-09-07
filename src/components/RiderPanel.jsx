import React, { useState } from 'react';
import { useT, useUnits } from '../engine/settings.jsx';
import { searchBikes, bikeLabel, rangeFromBike } from '../data/bikes.js';

// How this rider rides, and what they will actually stop for.
//
// Two different kinds of fact live here and they are deliberately not mixed:
//
//   RIDING is measurable — bike range, group pace, road appetite, tolls. It
//   seeds every new trip's meta, so the numbers the feasibility engine grades
//   against start out true instead of starting out 180/200/touring.
//
//   TASTE is prose the planner reads. It is soft evidence, not a constraint —
//   with one exception: DIETARY is a constraint, because "vegetarian" is not a
//   preference to be outranked by a great steakhouse on the route.
//
// Distinct from placePreferences.js, which infers taste from what you pick and
// reject. When the two disagree, what you typed here wins.

// Free-text tags rather than a fixed menu: the taxonomy of things a rider cares
// about is not something this app gets to define, and a wrong enum is worse
// than no enum — it teaches the model the wrong vocabulary.
function TagField({ label, hint, values, placeholder, onChange }) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const add = () => {
    const next = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (!next.length) return;
    const merged = [...values];
    for (const v of next) if (!merged.some((x) => x.toLowerCase() === v.toLowerCase())) merged.push(v);
    onChange(merged);
    setDraft('');
  };
  return (
    <div className="tagfield">
      <span className="set-label">{label}</span>
      {hint && <p className="set-note">{hint}</p>}
      {values.length > 0 && (
        <ul className="tag-list">
          {values.map((v) => (
            <li key={v}>
              <span>{v}</span>
              <button type="button" aria-label={`${t('Remove')} ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>✕</button>
            </li>
          ))}
        </ul>
      )}
      <div className="tag-add">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button type="button" className="btn" disabled={!draft.trim()} onClick={add}>{t('Add')}</button>
      </div>
    </div>
  );
}

// Type what you ride; the catalog answers with tank and economy, and those
// two produce the range the feasibility engine grades every fuel gap against.
// Nothing here is locked — the derived numbers land in the fields below and can
// be overwritten, because a rider's own observed economy beats any published
// figure and a bike with an auxiliary tank is not in any catalog.
function BikeField({ bike, onPick, onClear }) {
  const t = useT();
  const [q, setQ] = useState('');
  const hits = searchBikes(q);
  if (bike) {
    return (
      <div className="bike-picked">
        <div>
          <b>{bikeLabel(bike)}</b>
          <small>
            {bike.electric
              ? `${bike.rangeMi} ${t('mi claimed range')}`
              : `${bike.tank} ${t('gal')} · ${bike.mpg} ${t('mpg loaded')}`}
            {bike.years ? ` · ${bike.years}` : ''}
            {bike.source === 'manual' ? ` · ${t('your figures')}` : ''}
          </small>
        </div>
        <button type="button" className="btn compact" onClick={onClear}>{t('Change')}</button>
      </div>
    );
  }
  return (
    <div className="bike-search">
      <label className="fld">{t('What do you ride?')}
        <input value={q} placeholder={t('e.g. Road Glide, R 1250 GS, Gold Wing')} onChange={(e) => setQ(e.target.value)} />
      </label>
      {hits.length > 0 && (
        <ul className="sp-results">
          {hits.map((b) => (
            <li key={bikeLabel(b) + b.years}>
              <button type="button" onClick={() => onPick({ ...b, source: 'catalog' })}>
                <b>{bikeLabel(b)}</b>
                <small>
                  {b.electric ? `${b.rangeMi} mi range` : `${b.tank} gal · ${b.mpg} mpg loaded`} · {b.years}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && hits.length === 0 && (
        <p className="set-note">
          {t('Not in the catalog — set your tank size and economy below and the range follows from those.')}
        </p>
      )}
    </div>
  );
}

export default function RiderPanel({ profile, onRiding, onTaste, onCosts }) {
  const t = useT();
  const u = useUnits();
  const r = profile.riding;
  const taste = profile.taste;
  const costs = profile.costs;
  const num = (v, fallback) => (v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : fallback);

  return (
    <div className="set-section">
      <p className="set-note">
        {t('These seed every new trip and ride into what the AI proposes. Any single trip can still be changed on its own without touching these.')}
      </p>

      <span className="set-label">{t('Your bike')}</span>
      <BikeField
        bike={r.bike}
        onClear={() => onRiding({ bike: null })}
        onPick={(bike) => {
          const range = rangeFromBike(bike);
          onRiding({
            bike,
            ...(range ? { rangeComfort: range.comfort, rangeAbsolute: range.absolute } : {}),
          });
        }}
      />
      {r.bike && (
        <p className="set-note">
          {t('Range below was worked out from the tank and economy above, keeping a 20% reserve. Change either figure if yours differs.')}
        </p>
      )}

      <span className="set-label">{t('Riding')}</span>
      <div className="set-grid">
        <label className="fld">{t('Usual riders')}
          <input type="number" min="1" max="30" value={r.riders}
            onChange={(e) => onRiding({ riders: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label className="fld">{t('Roads')}
          <select value={r.style} onChange={(e) => onRiding({ style: e.target.value })}>
            <option value="quick">{t('Quick — highways welcome')}</option>
            <option value="touring">{t('Touring — balanced')}</option>
            <option value="backroads">{t('Back roads — avoid highways')}</option>
          </select>
        </label>
        <label className="fld">{t('Comfortable range')}
          <input type="number" min="40" value={r.rangeComfort}
            onChange={(e) => onRiding({ rangeComfort: num(e.target.value, 180) })} />
        </label>
        <label className="fld">{t('Absolute range')}
          <input type="number" min="40" value={r.rangeAbsolute}
            onChange={(e) => onRiding({ rangeAbsolute: num(e.target.value, 200) })} />
        </label>
        <label className="fld">{t('Usual departure')}
          <input type="time" value={r.departDefault}
            onChange={(e) => onRiding({ departDefault: e.target.value })} />
        </label>
        <label className="fld">{t('Max hours in a day')}
          <input type="number" min="1" max="16" placeholder={t('no limit')}
            value={r.dailyMaxHours ?? ''}
            onChange={(e) => onRiding({ dailyMaxHours: num(e.target.value, null) })} />
        </label>
      </div>
      <label className="fld check">
        <input type="checkbox" checked={r.avoidTolls === true}
          onChange={(e) => onRiding({ avoidTolls: e.target.checked })} />
        <span>{t('Avoid tolls')}<small>{t('Keeps tolled bridges and tunnels out of every route')}</small></span>
      </label>
      <p className="set-note">
        {t('Range is your bike’s, in the units above. The comfort figure is what fuel warnings grade against; absolute is what the engine treats as a hard limit.')}
      </p>

      <span className="set-label">{t('What a day costs')}</span>
      <p className="set-note">{t('Used by the budget estimate. Fuel comes from your bike’s economy above, so only the price is needed here.')}</p>
      <div className="set-grid">
        <label className="fld">{t('Fuel per gallon')}
          <input type="number" min="0" step="0.05" value={costs.gas}
            onChange={(e) => onCosts({ gas: num(e.target.value, 3.6) })} />
        </label>
        <label className="fld">{t('Lodging per night')}
          <input type="number" min="0" value={costs.lodging}
            onChange={(e) => onCosts({ lodging: num(e.target.value, 95) })} />
        </label>
        <label className="fld">{t('Food per day')}
          <input type="number" min="0" value={costs.food}
            onChange={(e) => onCosts({ food: num(e.target.value, 75) })} />
        </label>
      </div>

      <span className="set-label">{t('What you stop for')}</span>
      <TagField
        label={t('Food')}
        hint={t('What a good stop looks like to you.')}
        placeholder={t('e.g. diner breakfast, BBQ, local seafood')}
        values={taste.food}
        onChange={(food) => onTaste({ food })}
      />
      <TagField
        label={t('Dietary needs')}
        hint={t('Treated as a hard requirement, not a preference — the planner will not propose a stop that cannot feed you.')}
        placeholder={t('e.g. vegetarian, gluten free')}
        values={taste.dietary}
        onChange={(dietary) => onTaste({ dietary })}
      />
      <TagField
        label={t('Lodging')}
        placeholder={t('e.g. covered parking, cheap and clean, camping')}
        values={taste.lodging}
        onChange={(lodging) => onTaste({ lodging })}
      />
      <TagField
        label={t('Interests')}
        placeholder={t('e.g. twisty roads, hot springs, history, national parks')}
        values={taste.interests}
        onChange={(interests) => onTaste({ interests })}
      />
      <TagField
        label={t('Avoid')}
        hint={t('Also treated as a requirement — say it here and the planner routes and picks around it.')}
        placeholder={t('e.g. interstates, gravel, big cities')}
        values={taste.avoid}
        onChange={(avoid) => onTaste({ avoid })}
      />
      <label className="fld">{t('Anything else')}
        <textarea
          rows={3}
          value={taste.notes}
          placeholder={t('e.g. two-up on a loaded bagger, so no gravel and shorter days after 4pm')}
          onChange={(e) => onTaste({ notes: e.target.value })}
        />
      </label>
    </div>
  );
}

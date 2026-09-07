import React, { useEffect, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { tripSummary } from '../engine/tripEngine.js';
import { fmtDayDate } from '../engine/dates.js';
import { useT, useTT, useUnits } from '../engine/settings.jsx';

const KEY = 'moto.budget.v1';
// Trip-shaped extras stay here; the per-rider running costs and economy are
// the RIDER's, and come from their profile (Settings → Riding) so a new device
// does not start the estimate from a stranger's assumptions.
const DEFAULTS = { gas: 3.6, mpg: 45, riders: 7, lodging: 95, food: 75, tickets: 150, misc: 200 };

// The rider's own figures, where they have them, under the trip's own.
export function budgetBase(trip, profile) {
  const costs = profile?.costs ?? {};
  return {
    ...DEFAULTS,
    gas: Number(costs.gas) > 0 ? Number(costs.gas) : DEFAULTS.gas,
    lodging: Number(costs.lodging) >= 0 ? Number(costs.lodging) : DEFAULTS.lodging,
    food: Number(costs.food) >= 0 ? Number(costs.food) : DEFAULTS.food,
    riders: trip?.meta?.riders ?? DEFAULTS.riders,
    mpg: trip?.meta?.range?.mpg ?? DEFAULTS.mpg,
  };
}

// The per-rider estimate for surfaces that show the number without the sheet
// (the Prep board card). Same assumptions store, same math as the panel.
export function budgetEstimate(trip, routedLegsByDay, profile = null) {
  const base = budgetBase(trip, profile);
  let b;
  try { b = { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { b = base; }
  const summary = tripSummary(trip, routedLegsByDay);
  const nights = Math.max(0, trip.days.length - 1);
  const fuel = (summary.totalMiles / Math.max(1, b.mpg)) * b.gas;
  return Math.round(fuel + nights * b.lodging + trip.days.length * b.food + Number(b.tickets) + Number(b.misc));
}

export default function BudgetPanel() {
  const { state, routedLegsByDay, profile } = useTrip();
  const { trip } = state;
  const [b, setB] = useState(() => {
    const base = budgetBase(trip, profile?.profile);
    try { return { ...base, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return base; }
  });
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(b)); } catch { /* full */ }
  }, [b]);

  const summary = tripSummary(trip, routedLegsByDay);
  const nights = Math.max(0, trip.days.length - 1);
  const days = trip.days.length;

  const perDay = trip.days.map((d) => {
    const miles = summary.perDay.find((p) => p.id === d.id)?.miles ?? d.miles;
    const gallons = miles / Math.max(1, b.mpg);
    return { d, miles, gallons, fuelRider: gallons * b.gas, fuelGroup: gallons * b.gas * b.riders };
  });
  const fuelRider = perDay.reduce((a, r) => a + r.fuelRider, 0);
  const lodgingRider = nights * b.lodging;
  const foodRider = days * b.food;
  const perRider = fuelRider + lodgingRider + foodRider + Number(b.tickets) + Number(b.misc);
  const $ = (n) => `$${Math.round(n).toLocaleString()}`;
  const t = useT();
  const tt = useTT();
  const u = useUnits();

  const num = (k) => ({
    type: 'number', value: b[k], min: 0, step: k === 'gas' ? 0.05 : 1,
    onChange: (e) => setB({ ...b, [k]: parseFloat(e.target.value) || 0 }),
  });

  return (
    <div>
      <div className="day-head">
        <div className="eyebrow">{t('Fuel from routed miles · everything else adjustable')}</div>
        <h2>{t('Budget & fuel')}</h2>
        <div className="datebar">
          <span className="chip">≈ {$(perRider)} {t('$/rider').replace('$/', '/ ')}</span>
          <span className="chip">≈ {$(perRider * b.riders)} {t('$ group').replace('$ ', '/ ')}</span>
        </div>
      </div>

      <div className="section">
        <h3>{t('Assumptions')}</h3>
        <div className="budget-grid">
          <label className="fld">{t('Gas $/gal')}<input {...num('gas')} /></label>
          <label className="fld">MPG<input {...num('mpg')} /></label>
          <label className="fld">{t('Riders')}<input {...num('riders')} /></label>
          <label className="fld">{t('Lodging $/night/rider')}<input {...num('lodging')} /></label>
          <label className="fld">{t('Food $/day/rider')}<input {...num('food')} /></label>
          <label className="fld">{t('Tickets $/rider')}<input {...num('tickets')} /></label>
          <label className="fld">{t('Misc $/rider')}<input {...num('misc')} /></label>
        </div>
      </div>

      <div className="section">
        <h3>{t('Fuel by day')} <span className="cnt">{u.mi(summary.totalMiles)} · {b.mpg} mpg · ${b.gas.toFixed(2)}/gal</span></h3>
        <div className="table-wrap">
          <table className="scen-table">
            <thead><tr><th>{t('Day')}</th><th>{u.metric ? 'Km' : t('Miles')}</th><th>{t('Gal/bike')}</th><th>{t('$/rider')}</th><th>{t('$ group')}</th></tr></thead>
            <tbody>
              {perDay.map(({ d, miles, gallons, fuelRider: fr, fuelGroup }) => (
                <tr key={d.id}>
                  <td>{d.dow} {fmtDayDate(d.date)} <span className="scen-date">{tt(d.title).slice(0, 30)}</span></td>
                  <td>{u.miNum(miles)}</td>
                  <td>{gallons.toFixed(1)}</td>
                  <td>{$(fr)}</td>
                  <td>{$(fuelGroup)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <h3>{t('Per-rider total')}</h3>
        <table className="scen-table">
          <tbody>
            <tr><td>{t('Fuel')} ({u.mi(summary.totalMiles)})</td><td>{$(fuelRider)}</td></tr>
            <tr><td>{t('Lodging (row)') === 'Lodging (row)' ? 'Lodging' : t('Lodging (row)')} ({nights} {t('nights')} × ${b.lodging})</td><td>{$(lodgingRider)}</td></tr>
            <tr><td>{t('Food')} ({days} {t('days')} × ${b.food})</td><td>{$(foodRider)}</td></tr>
            <tr><td>{t('Tickets, entries & passes')}</td><td>{$(b.tickets)}</td></tr>
            <tr><td>{t('Misc / buffer')}</td><td>{$(b.misc)}</td></tr>
            <tr className="current"><td><b>{t('Total per rider')}</b></td><td><b>{$(perRider)}</b></td></tr>
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 10 }}>
          {t('Rule of thumb extras: cash in small bills for vendor-heavy events, and the $80 America the Beautiful pass if the route touches multiple national parks — it usually pays for itself twice.')}
        </p>
      </div>
    </div>
  );
}

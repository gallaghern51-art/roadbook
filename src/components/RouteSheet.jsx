import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useT, useUnits } from '../engine/settings.jsx';
import { routeOptions } from '../engine/routeOptions.js';
import { trafficEta } from '../engine/routing.js';
import NearbyPicker from './NearbyPicker.jsx';

// The ride, before it is ridden — and the surface a rider comes back to.
//
// Three field reports built this (owner, Sep 19–20, 2026):
//
//   "when someone just types in a destination and cancels ride mode, it takes
//    me to the planning mode. how can we make it easier to edit destination
//    and add stops?"   — cancelling Ride landed in the full trip workspace, a
//    map room with a day panel, for what was a two-point ride. Now Ride hands
//    back to THIS, with the ride still on it.
//
//   "on the from, to screen there should be an add stop option on there
//    before 'go'."      — stops are rows between From and To, added from the
//    same along-route search the day panel uses.
//
//   "it doesn't allow user to see the different recommended routes per
//    selection quick, touring, back roads"  — the Roads radio is gone. The
//    roads themselves are the choice: every option measured, on the map, with
//    its miles and its clock, before Go.
//
// Time is shown twice on purpose. Valhalla's figure is the road; Google's
// traffic-aware figure is the clock. The owner rode back from eastern Long
// Island and found Roadbook "much quicker on time compared to google maps" —
// measured on that corridor the same evening, the same 104 miles read 129 min
// free-flow against 154 min in traffic. A planner that only ever shows the
// first number is not wrong about the road; it is 20% optimistic about the
// day, which is exactly the number a rider plans around.
//
//   ride      { start, stops[], end, avoidTolls, optionId }
//   onChange(next)     edit in place
//   onGo(ride, option) the rider committed
//   onOptions(opts, selectedId)  the map draws them
export default function RouteSheet({ ride, onChange, onGo, onClose, onOptions, onChooseOnMap, onAdding, pace = 1, busyLabel, prefer = null, saved = [] }) {
  const t = useT();
  const u = useUnits();
  const [opts, setOpts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  // the sheet around us needs to know: the add-a-stop face is the PICKER and
  // wants the picker's height, not this frame's
  useEffect(() => { onAdding?.(adding); }, [adding]); // eslint-disable-line react-hooks/exhaustive-deps
  const [traffic, setTraffic] = useState({}); // option id → minutes, or 'na'
  const abort = useRef(null);
  const seq = useRef(0);

  const { start, end, stops = [], avoidTolls = false, optionId = null } = ride ?? {};
  // the identity of the ROUTE: re-measure when a point or a toll rule moves,
  // never when the rider merely picks a different line
  const sig = useMemo(() => JSON.stringify({
    s: start ? [start.lat, start.lng] : null,
    v: stops.map((w) => [w.lat, w.lng]),
    e: end ? [end.lat, end.lng] : null,
    avoidTolls,
  }), [start, end, stops, avoidTolls]);

  useEffect(() => {
    if (!start || !end) { setOpts(null); onOptions?.([], null); return undefined; }
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const my = ++seq.current;
    setBusy(true); setErr('');
    routeOptions({ start, stops, end, avoidTolls, pace, prefer, signal: ctl.signal })
      .then((list) => {
        if (my !== seq.current) return;
        setOpts(list);
        setTraffic({});
        // keep the rider's pick when the same road survives the edit
        const keep = list.find((o) => o.id === optionId) ?? list[0];
        onChange?.({ ...ride, optionId: keep?.id ?? null });
        onOptions?.(list, keep?.id ?? null);
      })
      .catch((e) => {
        if (my !== seq.current || ctl.signal.aborted) return;
        setOpts([]); onOptions?.([], null);
        setErr(t('No road found between those points right now.'));
        if (e) { /* the message is for us, the note is for the rider */ }
      })
      .finally(() => { if (my === seq.current) setBusy(false); });
    return () => ctl.abort();
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = opts?.find((o) => o.id === optionId) ?? opts?.[0] ?? null;

  // The clock, for the road the rider is actually looking at. One Google call
  // per selection, cached per option for the life of the screen — the ETA is
  // the whole reason this is here, and it is also the Pro SKU.
  useEffect(() => {
    if (!chosen || !start || !end || traffic[chosen.id] != null) return undefined;
    let dead = false;
    const id = setTimeout(() => {
      trafficEta(start, [...stops, end], pace, { avoidTolls, tolls: chosen.hasToll })
        .then((r) => { if (!dead) setTraffic((m) => ({ ...m, [chosen.id]: { min: r.seconds / 60, toll: r.toll ?? null } })); })
        .catch(() => { if (!dead) setTraffic((m) => ({ ...m, [chosen.id]: 'na' })); });
    }, 400);
    return () => { dead = true; clearTimeout(id); };
  }, [chosen?.id, sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id) => { onChange?.({ ...ride, optionId: id }); onOptions?.(opts ?? [], id); };
  const setStops = (next) => onChange?.({ ...ride, stops: next });
  const swap = () => onChange?.({ ...ride, start: end, end: start, stops: [...stops].reverse() });

  // Google prices tolls per corridor and currency. Never invent one: an
  // option with no answer says "Toll road" and stops there.
  const money = (toll) => (toll && Number.isFinite(toll.amount)
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: toll.currency || 'USD', maximumFractionDigits: 2 }).format(toll.amount)
    : null);

  const fmt = (min) => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
  };

  if (adding) {
    return (
      <NearbyPicker
        title={t('Add a stop to your route')}
        mode="add"
        variant="tiles"
        near={chosen?.geometry?.length
          ? { lat: chosen.geometry[Math.floor(chosen.geometry.length / 2)][1], lng: chosen.geometry[Math.floor(chosen.geometry.length / 2)][0] }
          : start}
        chain={chosen?.geometry?.map(([lng, lat]) => ({ lat, lng })) ?? null}
        routePrefs={chosen?.prefs}
        saved={saved}
        onPick={(place) => {
          setStops([...stops, {
            name: place.name, lat: place.lat, lng: place.lng, detail: place.detail ?? '',
            ...(place.source === 'google' && place.id ? { placeId: place.id, verified: 'google' } : {}),
            ...(place.placed ? { placed: place.placed } : {}),
          }]);
          setAdding(false);
        }}
        onClose={() => setAdding(false)}
        onChooseOnMap={onChooseOnMap ? () => { setAdding(false); onChooseOnMap(); } : null}
      />
    );
  }

  return (
    <section className="route-sheet" aria-label={t('Your route')}>
      <div className="rs-head">
        <b>{t('Your route')}</b>
        {onClose && <button className="mini-edit" onClick={onClose} aria-label={t('Close')}>✕</button>}
      </div>

      <div className="rs-od" role="group" aria-label={t('Route')}>
        <div className="rs-stop rs-from">
          <i className="rs-dot from" aria-hidden="true" />
          <span className="rs-k">{t('From')}</span>
          <span className="rs-v">{start?.name ?? t('Pick a start')}</span>
          <button className="mini-edit" onClick={swap} aria-label={t('Swap start and destination')} title={t('Swap')}>⇅</button>
        </div>

        {stops.map((s, i) => (
          <div className="rs-stop rs-via" key={`${s.lat},${s.lng},${i}`}>
            <i className="rs-dot via" aria-hidden="true" />
            <span className="rs-k">{t('Stop')}</span>
            <span className="rs-v">{s.name}</span>
            <button className="mini-edit" aria-label={t('Remove this stop')} title={t('Remove')}
              onClick={() => setStops(stops.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}

        <button className="rs-add" onClick={() => setAdding(true)}>
          <i className="rs-dot add" aria-hidden="true">＋</i> {t('Add a stop')}
        </button>

        <div className="rs-stop rs-to">
          <i className="rs-dot to" aria-hidden="true" />
          <span className="rs-k">{t('To')}</span>
          <span className="rs-v">{end?.name ?? t('Pick a destination')}</span>
        </div>
      </div>

      <label className="rs-tolls">
        <input type="checkbox" checked={avoidTolls} onChange={(e) => onChange?.({ ...ride, avoidTolls: e.target.checked })} />
        {t('Avoid tolls')}
      </label>

      <div className="rs-options" role="radiogroup" aria-label={t('Route options')}>
        {busy && !opts && <div className="nb-note">{busyLabel ?? t('Measuring the roads…')}</div>}
        {err && <div className="nb-note warn">{err}</div>}
        {opts?.map((o) => {
          const live = traffic[o.id];
          return (
            <button
              key={o.id} role="radio" aria-checked={o.id === chosen?.id}
              className={`rs-opt${o.id === chosen?.id ? ' active' : ''}`}
              onClick={() => pick(o.id)}
            >
              <span className="rs-opt-head">
                <b>{t(o.label)}</b>
                {o.fastest && opts.length > 1 && <span className="rs-tag fast">{t('Fastest')}</span>}
                {o.shortest && !o.fastest && opts.length > 1 && <span className="rs-tag">{t('Shortest')}</span>}
              </span>
              <span className="rs-opt-figs mono">
                <b>{fmt(o.minutes)}</b> · {u.miNum(o.miles)} {u.miUnit}
                {o.via && <> · {o.via}</>}
                {/* Valhalla knows every option's toll status for free; the
                    price needs Google and is only worth asking for the option
                    the rider has actually landed on. */}
                {o.hasToll && (
                  <span className="rs-toll">
                    {money(live?.toll) ? `· ${money(live.toll)} ${t('tolls')}` : `· ${t('Toll road')}`}
                  </span>
                )}
              </span>
              {o.id === chosen?.id && (
                <span className="rs-opt-traffic">
                  {live == null && t('Checking traffic…')}
                  {live === 'na' && t('Free-flowing road time — no live traffic')}
                  {live && live !== 'na' && (
                    Math.round(live.min - o.minutes) >= 5
                      ? <b className="warn">{fmt(live.min)} {t('in traffic right now')} · +{Math.round(live.min - o.minutes)} min</b>
                      : <>{t('Traffic is clear right now')}</>
                  )}
                  {o.hasToll && money(live?.toll) && <> · {t('toll estimated for this corridor')}</>}
                </span>
              )}
            </button>
          );
        })}
        {opts?.length === 1 && !busy && (
          <div className="nb-note">{t('There is one road worth riding between these points.')}</div>
        )}
      </div>

      <div className="rs-actions">
        <button className="btn gold" disabled={!chosen || !start || !end} onClick={() => onGo?.(ride, chosen)}>
          ▶ {t('Go')}
        </button>
      </div>
    </section>
  );
}

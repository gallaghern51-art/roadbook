import React, { useEffect, useRef, useState } from 'react';
import { CATEGORIES, CUISINES, cuisineLabel, searchNearby, enrichAlong, openAt, detourCost, priceGlyph } from '../engine/nearby.js';
import { geocode } from '../engine/geocode.js';
import { useT, useUnits } from '../engine/settings.jsx';

// One picker, three doors: add a stop to a day, SWAP a stop keeping its role,
// add a stop ahead mid-ride. Category chips + free text; a scope; rows that
// carry the facts a rider decides on — rating, price, distance, how far off
// the road they are riding, and whether it is open when they get there.
//
// The "+N min" detour is measured by Valhalla for the row that is expanded,
// never for the whole list: one tap, one honest number.
//
// props
//   near        {lat,lng}   bias centre
//   chain       [{lat,lng}] the day's routed line (optional) → along-route mode
//   fromAlong   miles       where "here" is on that line (bike or the stop)
//   nextStop    {lat,lng}   what the detour is measured against (optional)
//   etaMin      number      minute-of-day the rider reaches `near` (optional)
//   dow         0-6         weekday of that arrival (optional)
//   routePrefs  trip.meta.routePrefs
//   mode        'add' | 'swap' | 'ride'
//   initialCategory
//   onPick(place, { fuel })  the rider chose one
//   onClose()
export default function NearbyPicker({
  near, chain = null, fromAlong = 0, nextStop = null, etaMin = null, dow = null, routePrefs,
  mode = 'add', initialCategory = null, onPick, onClose, title, gateSlack = [],
  fuelPlan = null, // { comfortMi, marks: [alongMi of start, every fuel stop, end] } — for fuel rows on a routed day
  onRows = null,   // (pins, {fit, active}) → the caller draws them on the map as tappable pins
  tapped = null,   // {id, at} — a pin the rider tapped on the map: expand that row, scroll to it
  area = null,     // {lat, lng, at} — the rider pressed "Search this area" on the map
  halfSheet = false, // phone: the panel is a half sheet over the map — keep the picker at its top
}) {
  const t = useT();
  const u = useUnits();
  const [cat, setCat] = useState(initialCategory);
  const [sub, setSub] = useState(null); // cuisine under Food
  const [q, setQ] = useState('');
  const [scope, setScope] = useState(chain ? 'route' : 'near'); // near | route | area
  const [center, setCenter] = useState(null); // {lat,lng} — the map centre, for scope 'area'
  const rootRef = useRef(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null); // expanded row id
  const [detour, setDetour] = useState({}); // id → {minutes, miles} | 'busy' | 'na'
  const timer = useRef(null);
  const seq = useRef(0);

  const run = async () => {
    if (!cat && q.trim().length < 2) { setRows(null); return; }
    const my = ++seq.current;
    setBusy(true); setErr('');
    try {
      let res;
      try {
        const at = scope === 'area' && center ? center : near;
        res = await searchNearby({
          category: cat, subtype: cat === 'food' ? sub : null, query: q.trim(), near: at,
          radiusMi: scope === 'route' ? 60 : scope === 'area' ? 15 : 25,
          route: scope === 'route' && chain ? chain.map((p) => [p.lng, p.lat]) : null,
        });
      } catch (e) {
        // no Google key on this deploy → the free-text path still works
        if (!cat && q.trim()) res = (await geocode(q.trim(), near)).map((r) => ({ ...r }));
        else throw e;
      }
      if (my !== seq.current) return;
      const enriched = enrichAlong(res, chain, { near: scope === 'area' && center ? center : near, fromAlong });
      // sort: along-route by aheadMi (behind-you last) when the rider is
      // MOVING through the day (add / ride); by road distance from the stop
      // when swapping — "behind" means nothing for a stop you are replacing
      enriched.sort((a, b) => {
        if (scope === 'route' && Number.isFinite(a.aheadMi) && Number.isFinite(b.aheadMi)) {
          if (mode === 'swap') return Math.abs(a.aheadMi) - Math.abs(b.aheadMi);
          const ba = a.aheadMi < -0.3, bb = b.aheadMi < -0.3;
          if (ba !== bb) return ba ? 1 : -1;
          return a.aheadMi - b.aheadMi;
        }
        return (a.distMi ?? 1e9) - (b.distMi ?? 1e9);
      });
      setRows(enriched);
    } catch (e) {
      if (my !== seq.current) return;
      setErr(t('Search is not available right now.'));
      setRows([]);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  // chips and scope search at once; typing is debounced
  useEffect(() => { run(); }, [cat, sub, scope, center]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    clearTimeout(timer.current);
    if (!q.trim()) return undefined;
    timer.current = setTimeout(run, 450);
    return () => clearTimeout(timer.current);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastRows = useRef(null);
  useEffect(() => {
    const glyph = CATEGORIES.find((c) => c.id === cat)?.glyph ?? '📍';
    const fresh = rows !== lastRows.current; // a new list, not a row opening
    lastRows.current = rows;
    onRows?.((rows ?? []).map((r) => ({ id: String(r.id), lat: r.lat, lng: r.lng, name: r.name, glyph, hot: r.id === open })), { fit: fresh && (rows?.length ?? 0) > 0, active: true });
    // on a phone the panel is a half sheet while pins are up: the picker, not
    // the day header above it, is what should be in that half
    if (fresh && rows?.length && halfSheet) rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [rows, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onRows?.([], { active: false }), []); // eslint-disable-line react-hooks/exhaustive-deps
  // the half sheet arrives one render AFTER the pins that caused it — scroll then too
  useEffect(() => {
    if (!halfSheet) return undefined;
    const id = setTimeout(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    return () => clearTimeout(id);
  }, [halfSheet]);

  // A pin tapped on the map is a row chosen here: expand it and bring it into view.
  useEffect(() => {
    if (!tapped?.id || !rows) return;
    const r = rows.find((x) => String(x.id) === String(tapped.id));
    if (!r) return;
    if (open !== r.id) expand(r);
    requestAnimationFrame(() => rootRef.current?.querySelector(`[data-id="${CSS.escape(String(r.id))}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, [tapped?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Search this area": the map centre becomes the bias point
  useEffect(() => {
    if (!area?.at || !Number.isFinite(area.lat)) return;
    setCenter({ lat: area.lat, lng: area.lng });
    setScope('area');
    if (!cat && q.trim().length < 2) setCat('food'); // something to look for
  }, [area?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // A fuel candidate's worth is the stretch it leaves on either side. Marks are
  // the along-route positions of the start, every fuel stop and the end; the
  // candidate splits the gap it falls in. Past the comfortable range on either
  // side and it is not the station that fixes the day.
  const fuelVerdict = (r) => {
    if (!fuelPlan || cat !== 'fuel' || !Number.isFinite(r.alongMi)) return null;
    const before = Math.max(...fuelPlan.marks.filter((m) => m <= r.alongMi), -Infinity);
    const after = Math.min(...fuelPlan.marks.filter((m) => m >= r.alongMi), Infinity);
    const gapBefore = Number.isFinite(before) ? r.alongMi - before : null;
    const gapAfter = Number.isFinite(after) ? after - r.alongMi : null;
    const worst = Math.max(gapBefore ?? 0, gapAfter ?? 0);
    return { gapBefore, gapAfter, ok: worst <= fuelPlan.comfortMi, worst };
  };

  const expand = async (r) => {
    setOpen((cur) => (cur === r.id ? null : r.id));
    if (detour[r.id] || !nextStop || !near) return;
    setDetour((d) => ({ ...d, [r.id]: 'busy' }));
    try {
      const c = await detourCost(near, r, nextStop, routePrefs);
      setDetour((d) => ({ ...d, [r.id]: c }));
    } catch {
      setDetour((d) => ({ ...d, [r.id]: 'na' }));
    }
  };

  const openBadge = (r) => {
    if (etaMin == null || dow == null) return r.openNow == null ? null : (r.openNow ? { cls: 'ok', txt: t('Open now') } : { cls: 'bad', txt: t('Closed now') });
    const s = openAt(r.periods, etaMin, dow);
    if (s === 'unknown') return null;
    return s === 'open' ? { cls: 'ok', txt: t('Open at your ETA') } : { cls: 'bad', txt: t('Closed at your ETA') };
  };

  return (
    <div ref={rootRef} className={`nearby nearby-${mode}`} role="region" aria-label={title ?? t('Find a place')}>
      <div className="nb-head">
        <b>{title ?? (mode === 'swap' ? t('Swap this stop for…') : t('Find a place'))}</b>
        {onClose && <button className="mini-edit" onClick={onClose} aria-label={t('Cancel')}>✕</button>}
      </div>
      <div className="nb-chips" role="tablist">
        {CATEGORIES.map((c) => (
          <button
            key={c.id} role="tab" aria-selected={cat === c.id}
            className={`nb-chip${cat === c.id ? ' active' : ''}`}
            onClick={() => { setQ(''); setSub(null); setCat(cat === c.id ? null : c.id); }}
          ><i aria-hidden="true">{c.glyph}</i>{t(c.label)}</button>
        ))}
      </div>
      {cat === 'food' && (
        <div className="nb-chips nb-sub" role="tablist" aria-label={t('Kind of food')}>
          <button role="tab" aria-selected={!sub} className={`nb-chip${!sub ? ' active' : ''}`} onClick={() => setSub(null)}>{t('Any')}</button>
          {CUISINES.map((c) => (
            <button key={c.id} role="tab" aria-selected={sub === c.id} className={`nb-chip${sub === c.id ? ' active' : ''}`} onClick={() => setSub(sub === c.id ? null : c.id)}>{t(c.label)}</button>
          ))}
        </div>
      )}
      <div className="nb-row">
        <input
          className="nb-q"
          value={q}
          placeholder={cat ? t('Narrow it down — a name, a town…') : t('Search any place…')}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
        {(chain || center) && (
          <div className="nb-scope" role="radiogroup" aria-label={t('Where to look')}>
            {chain && <button role="radio" aria-checked={scope === 'route'} className={scope === 'route' ? 'active' : ''} onClick={() => setScope('route')}>{t('Along route')}</button>}
            <button role="radio" aria-checked={scope === 'near'} className={scope === 'near' ? 'active' : ''} onClick={() => setScope('near')}>{mode === 'ride' ? t('Near me') : t('Near here')}</button>
            {center && <button role="radio" aria-checked={scope === 'area'} className={scope === 'area' ? 'active' : ''} onClick={() => setScope('area')}>{t('Map area')}</button>}
          </div>
        )}
      </div>

      {busy && <div className="nb-note">{t('Searching…')}</div>}
      {err && <div className="nb-note warn">{err}</div>}
      {!busy && rows?.length === 0 && !err && <div className="nb-note">{t('Nothing found — try another chip or add the town name.')}</div>}

      {rows?.length > 0 && (
        <ul className="nb-list">
          {rows.map((r) => {
            const ob = openBadge(r);
            const d = detour[r.id];
            const behind = mode !== 'swap' && Number.isFinite(r.aheadMi) && r.aheadMi < -0.3;
            return (
              <li key={`${r.source}:${r.id}`} data-id={String(r.id)} className={`nb-item${open === r.id ? ' open' : ''}${behind ? ' behind' : ''}`}>
                <button className="nb-main" onClick={() => expand(r)} aria-expanded={open === r.id}>
                  <span className="nb-name">{r.name}</span>
                  <span className="nb-facts">
                    {/* what kind of place, first — the fact a rider scans a food list for */}
                    {cuisineLabel(r.primaryType, r.types, cat === 'food' ? sub : null) && <span className="nb-cuisine">{cuisineLabel(r.primaryType, r.types, cat === 'food' ? sub : null)}</span>}
                    {Number.isFinite(r.rating) && <span className="nb-rate">★ {r.rating.toFixed(1)}{r.userRatingCount ? <small> ({r.userRatingCount})</small> : null}</span>}
                    {priceGlyph(r.priceLevel) && <span className="nb-price">{priceGlyph(r.priceLevel)}</span>}
                    {Number.isFinite(r.offRouteMi) && scope === 'route'
                      ? <span className="nb-dist">{u.miNum(r.offRouteMi)} {u.miUnit} {t('off route')}{
                          mode === 'swap' && Number.isFinite(r.aheadMi) ? ` · ${u.miNum(Math.abs(r.aheadMi))} ${u.miUnit} ${t('from this stop')}`
                          : behind ? ` · ${t('behind you')}`
                          : Number.isFinite(r.aheadMi) ? ` · ${u.miNum(r.aheadMi)} ${u.miUnit} ${t('ahead')}` : ''
                        }</span>
                      : Number.isFinite(r.distMi) && <span className="nb-dist">{u.miNum(r.distMi)} {u.miUnit}</span>}
                    {ob && <span className={`nb-open ${ob.cls}`}>{ob.txt}</span>}
                    {(() => {
                      const f = fuelVerdict(r);
                      if (!f) return null;
                      return f.ok
                        ? <span className="nb-fuel ok">{t('Fills the gap')} · {u.miNum(f.gapBefore ?? 0)} / {u.miNum(f.gapAfter ?? 0)} {u.miUnit}</span>
                        : <span className="nb-fuel bad">{t('Still leaves')} {u.miNum(f.worst)} {u.miUnit} {t('past your')} {u.miNum(fuelPlan.comfortMi)} {u.miUnit} {t('range')}</span>;
                    })()}
                    {r.verified !== false && r.source === 'google' && <span className="nb-ver">✓</span>}
                  </span>
                  {r.detail && <span className="nb-addr">{r.detail}</span>}
                </button>
                {open === r.id && (
                  <div className="nb-more">
                    {nextStop && (
                      <div className="nb-detour">
                        {d === 'busy' && t('Measuring the detour…')}
                        {d === 'na' && t('Detour not measurable right now')}
                        {d && d !== 'busy' && d !== 'na' && (
                          <><b>+{Math.round(d.minutes)} min</b> · +{u.miNum(d.miles)} {u.miUnit} {t('detour on the way to the next stop')}</>
                        )}
                      </div>
                    )}
                    {/* the detour against every hard gate still ahead — the fact a
                        map app cannot know. Broken gates first. */}
                    {d && d !== 'busy' && d !== 'na' && gateSlack.length > 0 && (
                      <div className="nb-gates">
                        {gateSlack.map((g) => {
                          const left = g.marginMin - Math.round(d.minutes);
                          return (
                            <div key={g.label} className={`nb-gate ${left < 0 ? 'bad' : left < 20 ? 'warn' : 'ok'}`}>
                              {left < 0
                                ? `${t('Breaks')} ${g.label} (${g.by}) ${t('by')} ${Math.abs(left)} min`
                                : `${g.label} (${g.by}): ${left} min ${t('to spare')}`}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {Array.isArray(r.hours) && r.hours.length > 0 && (
                      <details className="nb-hours"><summary>{t('Hours')}</summary><ul>{r.hours.map((h, i) => <li key={i}>{h}</li>)}</ul></details>
                    )}
                    <div className="nb-actions">
                      <button className="btn gold" onClick={() => onPick(r, { fuel: cat === 'fuel' })}>
                        {mode === 'swap' ? t('Use this instead') : mode === 'ride' ? t('Add ahead') : t('Add to the day')}
                      </button>
                      {mode !== 'swap' && cat !== 'fuel' && (
                        <button className="btn" onClick={() => onPick(r, { fuel: true })}>{t('Add as fuel stop')}</button>
                      )}
                      {r.googleMapsUri && <a className="btn" href={r.googleMapsUri} target="_blank" rel="noreferrer">{t('Maps')}</a>}
                    </div>
                    <div className="nb-attrib">{t('Place facts from Google')}</div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

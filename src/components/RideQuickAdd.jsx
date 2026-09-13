import React, { useEffect, useRef, useState } from 'react';
import { searchNearby, enrichAlong, cuisineLabel } from '../engine/nearby.js';
import { useT, useUnits } from '../engine/settings.jsx';

// Mid-ride "I need fuel / food / coffee / help" — the interface for a gloved
// hand at a stop light, not the parked-bike browse the ride sheet carries.
//
// The whole design is subtraction. No text box, no chips row, no scope, no
// hours, no cuisine sub-menu. Four buttons the size of a thumb tip; then the
// THREE best candidates AHEAD on the road being ridden, each one big card with
// one "Add" — and voice reads them out, because eyes belong on the road.
// "Ahead" is along the active route, never straight-line, so a station on
// the return leg of a loop cannot pose as being up the road.
//
//   fix        {lat,lng}     the bike
//   chain      [{lat,lng}]   the active route geometry (planned or live)
//   fromAlong  miles         the bike's along-route position
//   speak(text)              Ride Mode's voice
//   onAdd(place, {fuel})     lands the stop through addStop
//   onClose()

const QUICK = [
  { id: 'fuel', label: 'Fuel', glyph: '⛽', fuel: true },
  { id: 'food', label: 'Food', glyph: '🍽', fuel: false },
  { id: 'coffee', label: 'Coffee', glyph: '☕', fuel: false },
  { id: 'help', label: 'Help', glyph: '✚', fuel: false },
];
const MAX_OFF_MI = 6;   // a place further off the road than this is a plan, not a quick stop
const SHOW = 3;

export default function RideQuickAdd({ fix, chain, fromAlong = 0, speak, onAdd, onClose, onRows = null, tapped = null }) {
  const t = useT();
  const u = useUnits();
  const [cat, setCat] = useState(null);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [hot, setHot] = useState(null); // a card lit from its pin on the map
  const seq = useRef(0);
  const recRef = useRef(null);
  const pickRef = useRef(null);

  // Voice-first: the overlay LISTENS the moment it opens. "Fuel", "gas",
  // "food", "coffee", "help" — one word, gloves stay on the bars. Web Speech
  // is Safari/Chrome-only and needs the same gesture that opened us, which
  // is why it starts here and not on a timer.
  const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  const heard = (text) => {
    const w = String(text || '').toLowerCase();
    const c = /fuel|gas|petrol|tank/.test(w) ? QUICK[0]
      : /food|eat|lunch|dinner|breakfast|hungry|restaurant|diner/.test(w) ? QUICK[1]
      : /coffee|cafe|caffeine/.test(w) ? QUICK[2]
      : /help|hospital|doctor|emergency|medic/.test(w) ? QUICK[3] : null;
    if (c) pickRef.current?.(c);
    return !!c;
  };
  const listen = () => {
    if (!SR || recRef.current) return;
    try {
      const rec = new SR();
      rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = false; rec.maxAlternatives = 3;
      rec.onresult = (e) => {
        const alts = [...(e.results?.[0] ?? [])].map((a) => a.transcript);
        if (!alts.some(heard)) speak?.(t('Say fuel, food, coffee or help.'));
      };
      rec.onend = () => { recRef.current = null; setListening(false); };
      rec.onerror = () => { recRef.current = null; setListening(false); };
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch { recRef.current = null; setListening(false); }
  };
  useEffect(() => { listen(); return () => { try { recRef.current?.abort?.(); } catch { /* gone */ } }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (c) => {
    try { recRef.current?.abort?.(); } catch { /* gone */ }
    setCat(c); setRows(null); setBusy(true);
    const my = ++seq.current;
    try {
      const res = await searchNearby({
        category: c.id, near: fix, radiusMi: 40,
        route: chain?.length > 1 ? chain.map((p) => [p.lng, p.lat]) : null, limit: 10,
      });
      if (my !== seq.current) return;
      const ahead = enrichAlong(res, chain, { near: fix, fromAlong })
        // ahead on the road, not too far off it; no line → nearest by distance
        .filter((r) => (chain ? Number.isFinite(r.aheadMi) && r.aheadMi > 0.2 && r.offRouteMi <= MAX_OFF_MI : true))
        .sort((a, b) => (chain ? a.aheadMi - b.aheadMi : (a.distMi ?? 1e9) - (b.distMi ?? 1e9)))
        .slice(0, SHOW);
      setRows(ahead);
      // the voice is the interface at speed
      if (!ahead.length) speak?.(t('Nothing ahead on this road.'));
      else speak?.(`${ahead.length === 1 ? t('One option ahead') : `${ahead.length} ${t('options ahead')}`}: ${ahead.map((r) => `${r.name}, ${u.miNum(chain ? r.aheadMi : r.distMi)} ${u.miUnit === 'mi' ? 'miles' : 'kilometres'}`).join('; ')}.`);
    } catch {
      if (my !== seq.current) return;
      setRows([]);
      speak?.(t('Search is not available right now.'));
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  pickRef.current = pick;

  // the cards on the map, as pins — the rider sees WHERE the three are on the road
  useEffect(() => {
    onRows?.((rows ?? []).map((r) => ({ id: String(r.id), lat: r.lat, lng: r.lng, name: r.name, glyph: cat?.glyph ?? '📍', hot: String(r.id) === hot })));
  }, [rows, hot, cat]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tapped?.id) { setHot(String(tapped.id)); document.querySelector(`.rqa-card[data-id="${CSS.escape(String(tapped.id))}"]`)?.scrollIntoView({ block: 'nearest' }); } }, [tapped?.at]);

  // Escape / a tap on the dimmed map closes it
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="rqa" role="dialog" aria-label={t('Add a stop ahead')} onClick={onClose}>
      <div className="rqa-panel" onClick={(e) => e.stopPropagation()}>
        <div className="rqa-head">
          <b>{cat ? `${cat.glyph} ${t(cat.label)} ${t('ahead')}` : t('Add a stop ahead')}</b>
          <button className="rqa-x" onClick={onClose} aria-label={t('Cancel')}>✕</button>
        </div>

        {!cat && (
          <div className="rqa-grid">
            {QUICK.map((c) => (
              <button key={c.id} className="rqa-big" onClick={() => pick(c)}>
                <i aria-hidden="true">{c.glyph}</i><span>{t(c.label)}</span>
              </button>
            ))}
            {SR && (
              <button className={`rqa-mic${listening ? ' on' : ''}`} onClick={listen} aria-pressed={listening}>
                {listening ? `🎙 ${t('Listening — say fuel, food, coffee or help')}` : `🎙 ${t('Tap to speak')}`}
              </button>
            )}
            <button className="rqa-more" onClick={() => onClose?.('sheet')}>{t('More options…')}</button>
          </div>
        )}

        {cat && busy && <div className="rqa-note">{t('Looking ahead…')}</div>}
        {cat && !busy && rows?.length === 0 && (
          <div className="rqa-empty">
            <p>{t('Nothing ahead on this road.')}</p>
            <button className="rqa-more" onClick={() => setCat(null)}>{t('Back')}</button>
          </div>
        )}
        {cat && rows?.length > 0 && (
          <div className="rqa-cards">
            {rows.map((r, i) => {
              const dist = chain ? r.aheadMi : r.distMi;
              const cuisine = cat.id === 'food' ? cuisineLabel(r.primaryType, r.types) : '';
              return (
                <button key={`${r.id}`} data-id={String(r.id)} className={`rqa-card${i === 0 ? ' first' : ''}${String(r.id) === hot ? ' hot' : ''}`} onClick={() => onAdd(r, { fuel: cat.fuel })}>
                  <span className="rqa-name">{r.name}{cuisine && <em>{cuisine}</em>}</span>
                  <span className="rqa-dist">
                    <b>{u.miNum(dist)}</b> {u.miUnit} {chain ? t('ahead') : ''}
                    {Number.isFinite(r.offRouteMi) && r.offRouteMi >= 0.3 && <small> · {u.miNum(r.offRouteMi)} {u.miUnit} {t('off route')}</small>}
                    {r.openNow === false && <small className="bad"> · {t('Closed now')}</small>}
                    {Number.isFinite(r.rating) && <small> · ★ {r.rating.toFixed(1)}</small>}
                  </span>
                  <span className="rqa-add">＋ {t('Add')}</span>
                </button>
              );
            })}
            <button className="rqa-more" onClick={() => setCat(null)}>{t('Back')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

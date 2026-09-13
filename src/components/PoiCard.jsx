import React, { useEffect, useState } from 'react';
import { searchNearby, poiCategory, poiGlyph, priceGlyph, cuisineLabel } from '../engine/nearby.js';
import { haversineMiles } from '../engine/tripEngine.js';
import { useT, useUnits } from '../engine/settings.jsx';

// The card for a POI the rider tapped ON THE MAP — the vector symbol under
// their finger, not a search result. The map gives us OSM's name, class and
// point; the facts a rider decides on (rating, price, hours, whether it is
// the place they think it is) are Google's, so the card resolves the name
// against Places near that point and shows the match when one is close and
// plausibly the same business. No match is not an error: the OSM place is
// still real, it just lands unverified, the same as any hand-placed pin.
//
//   poi     { name, cls, subclass, lat, lng }
//   day     the selected day, or null (then Add is disabled with a reason)
//   onAdd(place, { fuel })   place carries name/lat/lng and, when matched, placeId/verified
//   onClose()
const MATCH_MI = 0.35;

export default function PoiCard({ poi, day, onAdd, onClose }) {
  const t = useT();
  const u = useUnits();
  const [match, setMatch] = useState(undefined); // undefined = looking, null = none, object = Google row
  const cat = poiCategory(poi.cls, poi.subclass);
  const glyph = poiGlyph(poi.cls, poi.subclass);

  useEffect(() => {
    let dead = false;
    setMatch(undefined);
    (async () => {
      try {
        const words = String(poi.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        const lookup = (category) => searchNearby({ category, query: poi.name, near: { lat: poi.lat, lng: poi.lng }, radiusMi: 2, limit: 5 });
        const pick = (rows) => rows
          .map((r) => ({ r, d: haversineMiles({ lat: poi.lat, lng: poi.lng }, r) }))
          .filter(({ r, d }) => d <= MATCH_MI && (!words.length || words.some((w) => String(r.name).toLowerCase().includes(w))))
          .sort((a, b) => a.d - b.d)[0];
        // strict-typed first (ranks "Sinclair" among gas stations, not the
        // motel next door), then by NAME with no type at all — a theater, a
        // brewery, a bike shop are real listings no category filter can name
        let best = pick(await lookup(cat));
        if (dead) return;
        if (!best && cat && words.length) { best = pick(await lookup(null)); if (dead) return; }
        setMatch(best ? best.r : null);
      } catch { if (!dead) setMatch(null); }
    })();
    return () => { dead = true; };
  }, [poi.name, poi.lat, poi.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const place = match
    ? { name: match.name, lat: match.lat, lng: match.lng, detail: match.detail, placeId: match.id, source: 'google', verified: 'google' }
    : { name: poi.name, lat: poi.lat, lng: poi.lng, detail: '', source: 'osm' };
  const cuisine = match && cat === 'food' ? cuisineLabel(match.primaryType, match.types) : '';

  return (
    <div className="poi-card" role="dialog" aria-label={poi.name}>
      <div className="poi-head">
        <span className="poi-glyph" aria-hidden="true">{glyph}</span>
        <div className="poi-title">
          <b>{poi.name}</b>
          <small>{[cuisine, poi.subclass || poi.cls].filter(Boolean).join(' · ')}</small>
        </div>
        <button className="mini-edit" onClick={onClose} aria-label={t('Close')}>✕</button>
      </div>
      <div className="poi-facts">
        {match === undefined && <span className="nb-note">{t('Checking with Google…')}</span>}
        {match === null && <span className="nb-note">{t('No Google listing found here — it will be added as an unverified stop.')}</span>}
        {match && (
          <>
            {Number.isFinite(match.rating) && <span className="nb-rate">★ {match.rating.toFixed(1)}{match.userRatingCount ? <small> ({match.userRatingCount})</small> : null}</span>}
            {priceGlyph(match.priceLevel) && <span className="nb-price">{priceGlyph(match.priceLevel)}</span>}
            {match.openNow != null && <span className={`nb-open ${match.openNow ? 'ok' : 'bad'}`}>{match.openNow ? t('Open now') : t('Closed now')}</span>}
            <span className="nb-ver">✓ {t('Google')}</span>
            {match.detail && <span className="nb-addr">{match.detail}</span>}
          </>
        )}
      </div>
      <div className="poi-actions">
        <button className="btn gold" disabled={!day || match === undefined} onClick={() => onAdd(place, { fuel: cat === 'fuel' })}>
          {cat === 'fuel' ? `⛽ ${t('Add as fuel stop')}` : `＋ ${t('Add to this day')}`}
        </button>
        {match?.googleMapsUri && <a className="btn" href={match.googleMapsUri} target="_blank" rel="noreferrer">{t('Maps')}</a>}
        {!day && <small className="poi-hint">{t('Pick a day to add it')}</small>}
      </div>
      {match && <div className="nb-attrib">{t('Place facts from Google')} · {u.miNum(haversineMiles(poi, match))} {u.miUnit}</div>}
    </div>
  );
}

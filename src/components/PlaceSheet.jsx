import React, { useEffect, useState } from 'react';
import { placeDetails, photoUrl, todayIndex, hoursOnly } from '../engine/places.js';
import { priceGlyph } from '../engine/nearby.js';
import { useT } from '../engine/settings.jsx';

// Roadbook's own place page (owner, Sep 13 2026: "why would we link out to
// Google Maps? we should have our own detail page built like Google's").
// One sheet for every door — the POI tapped on the map, a picker row, later a
// stop — with the facts a rider decides on: a photo, rating, price, whether
// it is open and today's hours, Google's one-line summary, the weekly table,
// address, a number to call and the website. The caller slots in what Google
// cannot know (`facts`: detour, gates, fuel verdict, open at YOUR arrival) and
// what to do about it (`actions`). No link out: the rider stays in the app.
//
// Facts come from Google Place Details, fetched once per place id when the
// sheet opens (never for a list); the photo is one request per open.
//
//   place    { name, lat, lng, placeId?, detail?, rating?, userRatingCount?, priceLevel?, openNow?, hours?, phone?, websiteUri? }
//   glyph    category glyph for the roundel
//   kicker   the category line under the name
//   note     a line under the stats (looking / no listing)
//   facts    ReactNode — Roadbook's route facts
//   actions  ReactNode — the sheet's foot
export default function PlaceSheet({ place, glyph = '📍', kicker = '', note = null, facts = null, actions = null, onClose }) {
  const t = useT();
  const [more, setMore] = useState(null);
  const placeId = place?.placeId ?? null;

  useEffect(() => {
    let dead = false;
    setMore(null);
    if (!placeId) return undefined;
    placeDetails(placeId).then((d) => { if (!dead && d) setMore(d); });
    return () => { dead = true; };
  }, [placeId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // details win where present; the search row's facts stand until they land
  const p = { ...(place ?? {}), ...Object.fromEntries(Object.entries(more ?? {}).filter(([, v]) => v != null)) };
  const photos = Array.isArray(p.photos) ? p.photos.slice(0, 5) : [];
  const photo = photos[0] ?? null;
  const [allReviews, setAllReviews] = useState(false);
  const reviews = Array.isArray(p.reviews) ? p.reviews : [];
  const shown = allReviews ? reviews : reviews.slice(0, 2);
  const amen = Array.isArray(p.amenities) ? p.amenities : [];
  const yes = amen.filter((a) => a.ok).map((a) => a.label);
  const no = amen.filter((a) => !a.ok).map((a) => a.label);
  const hours = Array.isArray(p.hours) && p.hours.length ? p.hours : null;
  const today = todayIndex();
  const site = p.websiteUri ? String(p.websiteUri).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sheet place-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={p.name}>
        {photo && (
          <div className={`ps-hero${photos.length > 1 ? ' strip' : ''}`}>
            {photos.map((ph, i) => (
              <div className="ps-shot" key={ph.name}>
                <img src={photoUrl(ph.name, i === 0 ? 900 : 600)} alt="" loading={i === 0 ? 'eager' : 'lazy'} />
                {ph.by?.[0]?.name && (
                  ph.by[0].uri
                    ? <a className="ps-credit" href={ph.by[0].uri} target="_blank" rel="noreferrer">{t('Photo')}: {ph.by[0].name}</a>
                    : <span className="ps-credit">{t('Photo')}: {ph.by[0].name}</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="modal-head ps-head">
          <span className="poi-glyph" aria-hidden="true">{glyph}</span>
          <div>
            <h3>{p.name}</h3>
            {kicker && <div className="ps-kicker">{kicker}</div>}
          </div>
          <button className="btn" onClick={onClose} aria-label={t('Close')}>✕</button>
        </div>
        <div className="modal-body ps-body">
          <div className="ps-stats">
            {Number.isFinite(p.rating) && <span className="nb-rate">★ {p.rating.toFixed(1)}{p.userRatingCount ? <small> ({p.userRatingCount})</small> : null}</span>}
            {priceGlyph(p.priceLevel) && <span className="nb-price">{priceGlyph(p.priceLevel)}</span>}
            {p.openNow != null && <span className={`nb-open ${p.openNow ? 'ok' : 'bad'}`}>{p.openNow ? t('Open now') : t('Closed now')}</span>}
            {hours && <span className="ps-today">{t('Today')} {hoursOnly(hours[today])}</span>}
            {placeId && <span className="nb-ver">✓ {t('Google')}</span>}
          </div>
          {note && <p className="nb-note ps-note">{note}</p>}
          {p.summary && <p className="ps-summary">{p.summary}</p>}
          {facts && <div className="ps-facts">{facts}</div>}
          {(yes.length > 0 || no.length > 0) && (
            <div className="ps-amen">
              {yes.map((l) => <span key={l} className="ps-chip ok">✓ {t(l)}</span>)}
              {no.slice(0, 4).map((l) => <span key={l} className="ps-chip no">✕ {t(l)}</span>)}
            </div>
          )}
          {hours && (
            <details className="nb-hours ps-hours">
              <summary>{t('Hours')}</summary>
              <ul>{hours.map((h, i) => <li key={i} className={i === today ? 'today' : ''}>{h}</li>)}</ul>
            </details>
          )}
          {(p.detail || p.phone || site) && (
            <ul className="ps-contact">
              {p.detail && <li><span className="ps-ic" aria-hidden="true">⌖</span><span>{p.detail}</span></li>}
              {p.phone && <li><span className="ps-ic" aria-hidden="true">☏</span><a href={`tel:${String(p.phone).replace(/[^\d+]/g, '')}`}>{p.phone}</a></li>}
              {site && <li><span className="ps-ic" aria-hidden="true">⌂</span><a href={p.websiteUri} target="_blank" rel="noreferrer">{site}</a></li>}
            </ul>
          )}
          {reviews.length > 0 && (
            <div className="ps-reviews">
              <div className="mono ps-label">{t('Reviews')}</div>
              {shown.map((r, i) => (
                <blockquote key={i} className="ps-review">
                  <div className="ps-review-head">
                    {Number.isFinite(r.rating) && <span className="nb-rate">{'★'.repeat(Math.round(r.rating))}</span>}
                    <span className="ps-review-by">{r.uri ? <a href={r.uri} target="_blank" rel="noreferrer">{r.by}</a> : r.by}</span>
                    <span className="ps-review-when">{r.when}</span>
                  </div>
                  <p>{r.text}</p>
                </blockquote>
              ))}
              {reviews.length > 2 && !allReviews && <button className="btn" onClick={() => setAllReviews(true)}>{t('More reviews')} ({reviews.length - 2})</button>}
            </div>
          )}
          {placeId && <div className="nb-attrib">{photo ? t('Place facts, photos and reviews from Google') : t('Place facts from Google')}</div>}
        </div>
        {actions && <div className="modal-foot ps-foot">{actions}</div>}
      </div>
    </div>
  );
}

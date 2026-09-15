import React, { useEffect, useState } from 'react';
import PlaceSheet from './PlaceSheet.jsx';
import { searchNearby, poiCategory, poiGlyph, poiIsNatural, cuisineLabel } from '../engine/nearby.js';
import { haversineMiles } from '../engine/tripEngine.js';
import { coordLabel } from '../engine/places.js';
import { placeStamp } from '../engine/placesProvider.js';
import { useT, useUnits } from '../engine/settings.jsx';

// The card for a POI the rider tapped ON THE MAP — the vector symbol under
// their finger, not a search result. The map gives us OSM's name, class and
// point; the facts a rider decides on (rating, price, hours, whether it is
// the place they think it is) are Google's, so the card resolves the name
// against Places near that point and shows the match when one is close and
// plausibly the same business. No match is not an error: the OSM place is
// still real, it just lands unverified, the same as any hand-placed pin.
// The surface is PlaceSheet — Roadbook's own place page, not a link out.
//
//   poi     { name, cls, subclass, lat, lng }
//   day     the selected day, or null (then Add is disabled with a reason)
//   onAdd(place, { fuel })   place carries name/lat/lng and, when matched, placeId/verified
//   onClose()
const MATCH_MI = 0.35;

/**
 * The Google listing for a vector POI: undefined while looking, null when none, else the row.
 * A NATURAL feature (peak, pass, forest, lake — `poiIsNatural`) is never
 * looked up: Google does not list a mountain the way it lists a diner, and
 * "no listing" would be the wrong answer about a real place. It resolves to
 * null at once, and the card treats it as a placed pin, not a failed lookup.
 */
export function usePoiMatch(poi) {
  const [match, setMatch] = useState(undefined);
  const cat = poiCategory(poi?.cls, poi?.subclass);
  const natural = !!poi && poiIsNatural(poi.cls, poi.subclass);
  useEffect(() => {
    let dead = false;
    setMatch(natural ? null : undefined);
    if (!poi || natural) return undefined;
    (async () => {
      try {
        const words = String(poi.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
        // restrict, not bias: a 2-mile bias still returns the best-named match
        // anywhere in the country (field-caught: Mirch Masala in Billings came
        // back as five other Mirch Masalas, none within 500 miles)
        const lookup = (category) => searchNearby({ category, query: poi.name, near: { lat: poi.lat, lng: poi.lng }, radiusMi: 2, limit: 5, restrict: true });
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
  }, [poi?.name, poi?.lat, poi?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  return match;
}

export default function PoiCard({ poi, day, onAdd, onClose }) {
  const t = useT();
  const u = useUnits();
  // A dropped pin (poi.placed) is the rider's own coordinate: nothing to look
  // up, nothing to verify — it rides as a deliberate `placed` pin.
  const placed = poi.placed ?? null;
  const looked = usePoiMatch(placed ? null : poi);
  const match = placed ? null : looked;
  const cat = poiCategory(poi.cls, poi.subclass);
  const glyph = placed ? '◎' : poiGlyph(poi.cls, poi.subclass);
  const natural = !placed && poiIsNatural(poi.cls, poi.subclass); // a peak, a pass, a forest: a placed pin, never a lookup

  const place = match
    ? { ...match, name: match.name, lat: match.lat, lng: match.lng, detail: match.detail, source: match.source ?? 'google', ...placeStamp({ ...match, source: match.source ?? 'google' }) }
    : placed
    ? { name: poi.name, lat: poi.lat, lng: poi.lng, detail: poi.detail ?? '', source: 'rider', placed }
    : { name: poi.name, lat: poi.lat, lng: poi.lng, detail: '', source: 'osm', ...(natural ? { placed: 'rider', kind: 'photo' } : {}) };
  const elev = poi.elevFt ? `${u.metric ? `${Math.round(poi.elevFt / 3.28084)} m` : `${poi.elevFt.toLocaleString()} ft`}` : '';
  const cuisine = match && cat === 'food' ? cuisineLabel(match.primaryType, match.types) : '';

  const dist = match ? `${u.miNum(haversineMiles(poi, match))} ${u.miUnit}` : '';
  return (
    <PlaceSheet
      place={place}
      glyph={glyph}
      kicker={placed ? (poi.detail && poi.detail !== poi.name ? poi.detail : coordLabel(poi)) : [cuisine, elev, (poi.subclass || poi.cls).replace(/_/g, ' ')].filter(Boolean).join(' · ')}
      note={placed ? t('A spot you placed on the map — not a listed business. It rides as a deliberate pin.') : natural ? t('A place on the map, not a listed business — it will be added as a placed pin.') : match === undefined ? t('Checking the listing…') : match === null ? t('No listing found here — it will be added as an unverified stop.') : null}
      facts={placed ? <span className="tag placed">◎ {t('placed')}</span> : match && dist ? <span className="nb-note">{t('Listing')} {dist} {t('from the pin')}</span> : null}
      onClose={onClose}
      actions={(
        <>
          <button className="btn gold" disabled={!day || match === undefined} onClick={() => onAdd(place, { fuel: cat === 'fuel' })}>
            {cat === 'fuel' ? `⛽ ${t('Add as fuel stop')}` : natural ? `📷 ${t('Add as photo stop')}` : `＋ ${t('Add to this day')}`}
          </button>
          {!day && <small className="poi-hint">{t('Pick a day to add it')}</small>}
        </>
      )}
    />
  );
}

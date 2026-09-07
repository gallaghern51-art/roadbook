import React, { useRef, useState } from 'react';
import { geocode } from '../engine/geocode.js';
import { useT } from '../engine/settings.jsx';
import { PLACE_ROLES } from '../engine/profile.js';

// The places a rider keeps: home, work, and anything they leave from or aim at
// often enough to be tired of typing.
//
// The point is not the address book — it is that "start at home" in a planning
// prompt has to become a real coordinate instead of the model's best guess at
// which Springfield you meant. So every place here is SEARCHED, not typed:
// what gets stored is a geocoder's answer with a lat/lng, the same standard the
// rest of the app holds AI-authored stops to.

const ROLE_LABEL = {
  home: 'Home',
  work: 'Work',
  favorite: 'Favorite',
};

function PlaceRow({ place, onRole, onRemove, t }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <li className="saved-place">
      <div className="sp-main">
        <b>{place.label}</b>
        {place.address && <small>{place.address}</small>}
      </div>
      <select
        className="sp-role"
        value={place.role}
        aria-label={t('Kind of place')}
        onChange={(e) => onRole(e.target.value)}
      >
        {PLACE_ROLES.map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}
      </select>
      <button
        type="button"
        className={`btn compact${confirm ? ' danger-ghost' : ''}`}
        onClick={() => (confirm ? onRemove() : (setConfirm(true), setTimeout(() => setConfirm(false), 3000)))}
      >
        {confirm ? t('Sure?') : '✕'}
      </button>
    </li>
  );
}

export default function PlacesPanel({ profile, onSave, onRemove }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [role, setRole] = useState('home');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const places = profile?.places ?? [];
  const hasHome = places.some((p) => p.role === 'home');

  const search = (text) => {
    setQ(text);
    clearTimeout(timer.current);
    if (text.trim().length < 3) { setResults([]); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try { setResults(await geocode(text)); } catch { setResults([]); } finally { setBusy(false); }
    }, 400);
  };

  const pick = (r) => {
    onSave({
      role,
      label: r.name,
      address: r.detail ?? '',
      lat: r.lat,
      lng: r.lng,
      // Google's id is a real place identity the router can aim at; Nominatim's
      // is not, and must never ride along pretending to be one.
      placeId: r.source === 'google' && r.id ? r.id : null,
    });
    setQ('');
    setResults([]);
    setRole('favorite');
  };

  return (
    <div className="set-section">
      <p className="set-note">
        {t('Saved places give the planner real coordinates. Say “start at home” and it uses this address instead of guessing.')}
      </p>

      {places.length > 0 && (
        <ul className="saved-places">
          {[...places].sort((a, b) => PLACE_ROLES.indexOf(a.role) - PLACE_ROLES.indexOf(b.role)).map((p) => (
            <PlaceRow
              key={p.id}
              place={p}
              t={t}
              onRole={(next) => onSave({ ...p, role: next })}
              onRemove={() => onRemove(p.id)}
            />
          ))}
        </ul>
      )}

      {!hasHome && (
        <p className="set-note warn">{t('No home address yet — add one and the builder can start a trip from it.')}</p>
      )}

      <div className="sp-add">
        <div className="set-seg sp-roles" role="group" aria-label={t('Kind of place')}>
          {PLACE_ROLES.map((r) => (
            <button key={r} type="button" className={role === r ? 'active' : ''} onClick={() => setRole(r)}>
              {t(ROLE_LABEL[r])}
            </button>
          ))}
        </div>
        <label className="fld">{t('Search for the address')}
          <input
            value={q}
            placeholder={t('e.g. 1500 Harbor Blvd, Weehawken NJ')}
            onChange={(e) => search(e.target.value)}
          />
        </label>
        {busy && <div className="set-note">{t('Searching…')}</div>}
        {results.length > 0 && (
          <ul className="sp-results">
            {results.map((r, i) => (
              <li key={`${r.id ?? r.name}-${i}`}>
                <button type="button" onClick={() => pick(r)}>
                  <b>{r.name}</b>
                  {r.detail && <small>{r.detail}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { Sheet } from './Sheets.jsx';
import { useT } from '../engine/settings.jsx';

// Save a place — a dropped pin, a tapped place, a search result — the way a
// map app saves one (owner, Sep 22 2026: "save the location as favorite or a
// list"): what to call it, which lists it goes in (Favorites and the rider's
// own), optionally Home or Work, and a note. It writes the rider's PROFILE, so
// a saved place follows the account to a new phone and the planner can use it
// ("start from home", "route me past my moto shops").
//
//   place    the card's place: { name, lat, lng, detail?, placeId?, source?, placed? }
//   saved    the saved row this place already is, or null
//   lists    the rider's own lists [{ id, name }]
//   onSave   ({ label, note, favorite, lists, role }) — nothing ticked removes it
//   onCreateList(name) → the new list's id
export default function SavePlaceSheet({ place, saved = null, lists = [], onSave, onCreateList, onClose }) {
  const t = useT();
  const [label, setLabel] = useState(saved?.label ?? place.name ?? '');
  const [note, setNote] = useState(saved?.note ?? '');
  const [role, setRole] = useState(saved && (saved.role === 'home' || saved.role === 'work') ? saved.role : null);
  // a first save lands in Favorites unless the rider picks otherwise — the
  // one tap a map app's star is
  const [favorite, setFavorite] = useState(saved ? saved.role === 'favorite' : true);
  const [inLists, setInLists] = useState(saved?.lists ?? []);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  const toggleList = (id) => setInLists((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const makeList = () => {
    const name = newName.trim();
    if (!name) return;
    const id = onCreateList(name);
    setInLists((cur) => [...cur, id]);
    setNewName('');
    setAdding(false);
  };
  const nothing = !role && !favorite && inLists.length === 0;
  const submit = () => {
    if (nothing && !saved) return;
    onSave({ label: label.trim() || place.name, note: note.trim(), favorite: !role && favorite, lists: inLists, role });
    onClose();
  };

  const Toggle = ({ on, onClick, children, glyph }) => (
    <button type="button" role="checkbox" aria-checked={on} className={`sv-toggle${on ? ' on' : ''}`} onClick={onClick}>
      <span className="sv-box" aria-hidden="true">{on ? '✓' : ''}</span>
      {glyph && <span className="sv-glyph" aria-hidden="true">{glyph}</span>}
      <span className="sv-name">{children}</span>
    </button>
  );

  return (
    <Sheet
      eyebrow={saved ? t('Saved place') : t('Save place')}
      title={place.name}
      onClose={onClose}
      foot={(
        <>
          {saved
            ? <button className="btn danger-ghost" onClick={() => { onSave({ label, note, favorite: false, lists: [], role: null }); onClose(); }}>{t('Remove from saved')}</button>
            : <span className="foot-note" />}
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn gold" disabled={nothing && !saved} onClick={submit}>{nothing && saved ? t('Remove from saved') : t('Save')}</button>
        </>
      )}
    >
      <div className="sv-sheet">
        <label className="fld">{t('Name')}
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={place.name} maxLength={80} />
        </label>

        <div className="sv-group" role="group" aria-label={t('Save to')}>
          <div className="mono sv-label">{t('Save to')}</div>
          <Toggle on={!role && favorite} glyph="★" onClick={() => { setRole(null); setFavorite((v) => !(role ? false : v)); }}>{t('Favorites')}</Toggle>
          {lists.map((l) => (
            <Toggle key={l.id} on={inLists.includes(l.id)} glyph="▤" onClick={() => toggleList(l.id)}>{l.name}</Toggle>
          ))}
          {adding ? (
            <div className="sv-new">
              <input autoFocus value={newName} maxLength={60} placeholder={t('e.g. Moto shops')}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') makeList(); if (e.key === 'Escape') setAdding(false); }} />
              <button type="button" className="btn gold" disabled={!newName.trim()} onClick={makeList}>{t('Add')}</button>
            </div>
          ) : (
            <button type="button" className="sv-add" onClick={() => setAdding(true)}>＋ {t('New list')}</button>
          )}
        </div>

        <div className="sv-group" role="group" aria-label={t('Use it as')}>
          <div className="mono sv-label">{t('Use it as')} <span>{t('optional — the planner reads these when you say “from home”')}</span></div>
          <div className="set-seg sv-roles">
            {['home', 'work'].map((r) => (
              <button key={r} type="button" className={role === r ? 'active' : ''} aria-pressed={role === r}
                onClick={() => setRole((cur) => (cur === r ? null : r))}>
                {r === 'home' ? t('Home') : t('Work')}
              </button>
            ))}
          </div>
        </div>

        <label className="fld">{t('Note')}
          <textarea rows={2} value={note} maxLength={500} placeholder={t('e.g. cheapest gas on the corridor, covered parking')} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </Sheet>
  );
}

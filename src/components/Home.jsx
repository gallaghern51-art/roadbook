import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { tripFeasibility } from '../engine/timeline.js';
import { tripSummary, haversineMiles } from '../engine/tripEngine.js';
import { fmtLongDate } from '../engine/dates.js';
import { SEED_TRIP } from '../data/seedTrip.js';
import { EARLY_EXIT_TRIP } from '../data/earlyExitTemplate.js';
import RouteSilhouette from './RouteSilhouette.jsx';
import { RoadbookBrand, SettingsIcon } from './Chrome.jsx';
import { useT, useUnits } from '../engine/settings.jsx';
import { libraryTrips, libraryTemplates, libraryQuickRides } from '../engine/templates.js';
import { locateOnce } from '../engine/quickRide.js';
import { CATEGORIES, searchNearby, poiCategory, poiGlyph, poiIsNatural, cuisineLabel, priceGlyph } from '../engine/nearby.js';
import { hoursOnly, todayIndex } from '../engine/places.js';
import InstallPrompt from './InstallPrompt.jsx';
import NearbyPicker from './NearbyPicker.jsx';
import HomeMap from './HomeMap.jsx';
import { BASEMAPS } from '../engine/basemaps.js';
import PlaceSheet from './PlaceSheet.jsx';
import { usePoiMatch } from './PoiCard.jsx';
import { Sheet } from './Sheets.jsx';

// The front door is the MAP (owner, Sep 13 2026: "build out option A"). The
// Mapbox map near you with tappable POIs, the picker's categories as chips, a
// search pill that is both doors — a place name searches the map, a sentence
// opens the AI builder — and a sheet that peeks with the two verbs (Plan a
// trip with AI · Ride now) and your trips, then pulls up to everything the
// old home had. Tap a place and the sheet becomes its card: Ride here (a
// quick ride), Add to a trip, Details. Nothing links out.

const RECENT_KEY = 'moto.homeRecent.v1';
const loadRecent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
const pushRecent = (row) => {
  try {
    const list = [row, ...loadRecent().filter((r) => r.name !== row.name)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch { /* storage full */ }
};
// a sentence is a plan, a name is a place: five words or riders/days/loop is the builder's
const readsAsPlan = (q) => /\b(riders?|days?|loop|nights?|weekend|trip)\b/i.test(q) || q.trim().split(/\s+/).length >= 5;
// Three positions for the sheet (owner, Sep 13 2026: "what if a user wants
// to dismiss the lower screen? or expand the trips view?"): MIN is the handle
// alone — the map is the screen; PEEK is the trips row; UP is the whole old
// home with the trips as a grid. The handle drags between them and snaps; a
// tap on it steps up; a tap on the map steps down. There are no verb buttons:
// the pill is the one door (owner: "there's like 4 different buttons for
// riding… too much trying to do everything at once") — a place → its card →
// Ride here; a sentence → the AI builder; an empty pill → one standing
// "Plan a trip with AI" row.
const SHEET_PX = { min: 0.06, peek: 0.42, up: 0.86 };
const DETENTS = ['min', 'peek', 'up'];
const nearestDetent = (frac) => DETENTS.reduce((best, k) => (Math.abs(SHEET_PX[k] - frac) < Math.abs(SHEET_PX[best] - frac) ? k : best), 'peek');

export default function Home({ onOpenTrip, onNewTrip, onImport, onDeleteTrip, onSettings, onHelp, onUseTemplate, onShareTemplate, onDeleteTemplate, onQuickRide, onRideAgain, onPromoteQuick, onDeleteQuick, onAddToTrip, quickDefaults }) {
  const { state, routedLegsByDay } = useTrip();
  const { lib } = state;
  const t = useT();
  const u = useUnits();

  const templates = useMemo(() => libraryTemplates(lib), [lib]);
  const quickRides = useMemo(() => libraryQuickRides(lib).slice(0, 4), [lib]);
  const trips = useMemo(() => libraryTrips(lib), [lib]);
  const cards = useMemo(() => trips.map((rec) => {
    const legs = rec.id === lib.activeId ? routedLegsByDay : {};
    const feas = tripFeasibility(rec.trip, legs);
    const summary = tripSummary(rec.trip, legs);
    const days = rec.trip.days;
    return { rec, grade: feas.grade, score: feas.overall, miles: summary.totalMiles, dayCount: days.length, from: days[0]?.date ?? rec.trip.meta.startDate, to: days[days.length - 1]?.date ?? rec.trip.meta.startDate, riders: rec.trip.meta.riders };
  }), [trips, lib.activeId, routedLegsByDay]);

  // where "near you" is: a fix, else the profile's home place, else nowhere
  const home = quickDefaults?.home && Number.isFinite(quickDefaults.home.lat) ? { lat: quickDefaults.home.lat, lng: quickDefaults.home.lng, name: quickDefaults.home.name || 'Home' } : null;
  const [fix, setFix] = useState(home);
  const [fixErr, setFixErr] = useState('');
  const locate = async () => {
    setFixErr('');
    try { const f = await locateOnce(); setFix({ ...f, name: 'Current location' }); return f; } catch {
      if (!home) setFixErr(t('Could not get your location. Allow location access, or set a home place in Settings → Places.'));
      return home;
    }
  };
  useEffect(() => { locate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [sheet, setSheet] = useState('peek'); // min | peek | up
  const [dragH, setDragH] = useState(null);   // the sheet's height while the handle is being dragged
  const [basemap, setBasemap] = useState('sat');
  const [terrain3d, setTerrain3d] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [bearing, setBearing] = useState(0); // the map's rotation; North up shows only while it is turned
  const [fixTried, setFixTried] = useState(false); // the location note only after the rider ASKS (the locate button), not on every open
  const [drawer, setDrawer] = useState(false); // desktop: the library is a DRAWER off the nav bar, closed by default — the map owns the screen
  const dragRef = useRef(null);
  const stepDown = () => setSheet((s) => (s === 'up' ? 'peek' : 'min'));
  const stepUp = () => setSheet((s) => (s === 'min' ? 'peek' : 'up'));
  // the handle: a drag follows the finger and snaps to the nearest position on
  // release; a tap (no travel) steps up, and steps back down from the top
  const onHandleDown = (e) => {
    const vh = window.innerHeight;
    dragRef.current = { y0: e.clientY, h0: vh * SHEET_PX[sheet], vh, moved: false, id: e.pointerId };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* a synthetic pointer has no capture */ }
  };
  const onHandleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = d.y0 - e.clientY;
    if (Math.abs(dy) > 6) d.moved = true;
    if (d.moved) setDragH(Math.max(d.vh * 0.1, Math.min(d.vh * 0.92, d.h0 + dy)));
  };
  const onHandleUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragH(null);
    if (!d) return;
    if (!d.moved) { setSheet((s) => (s === 'up' ? 'peek' : s === 'peek' ? 'up' : 'peek')); return; }
    setSheet(nearestDetent(Math.max(d.vh * 0.1, Math.min(d.vh * 0.92, d.h0 + (d.y0 - e.clientY))) / d.vh));
  };
  const [chip, setChip] = useState(null);      // a category → the picker in the sheet
  const [pins, setPins] = useState([]);
  const [fitAt, setFitAt] = useState(0);
  const [tapped, setTapped] = useState(null);
  const [place, setPlace] = useState(null);    // { poi, row? } → the place card
  const [focus, setFocus] = useState(null);
  const [center, setCenter] = useState(null); // where the map is looking — the chips and the search look there too
  const [searching, setSearching] = useState(false);
  const [addTo, setAddTo] = useState(null);    // a place → which trip?
  const sheetPx = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * (place ? 0.34 : chip ? 0.62 : SHEET_PX[sheet]));
  const near = center ?? fix ?? home ?? { lat: 45.9, lng: -108.5 };

  const showPlace = (poi, row = null) => {
    setPlace({ poi, row });
    setFocus({ lat: poi.lat, lng: poi.lng, at: Date.now() });
    if (row) pushRecent({ name: row.name, lat: row.lat, lng: row.lng, detail: row.detail ?? '' });
  };
  const rowToPoi = (r) => ({ name: r.name, lat: r.lat, lng: r.lng, cls: r.primaryType ?? '', subclass: r.primaryType ?? '' });

  const rideTo = async (dest, prefs) => {
    const start = fix ?? (await locate());
    if (!start) return;
    onQuickRide({ start, dest, routePrefs: { style: prefs?.style ?? quickDefaults?.routePrefs?.style ?? 'touring', avoidTolls: prefs?.avoidTolls ?? !!quickDefaults?.routePrefs?.avoidTolls } });
  };

  return (
    <div className="home home-map">
      <HomeMap
        fix={fix}
        focus={focus}
        pins={pins}
        fitAt={fitAt}
        sheetPx={sheetPx}
        onPinTap={(id) => setTapped({ id, at: Date.now() })}
        onCenter={setCenter}
        onBearing={setBearing}
        basemap={basemap}
        terrain3d={terrain3d}
        onPoi={(poi) => { if (poi) showPlace(poi); else if (place) setPlace(null); else if (!chip) stepDown(); }} // a tap on open map: the card closes, or the sheet steps down
      />

      <div className="hm-top">
        <div className="hm-pillrow">
          <div className="hm-brand" aria-hidden="true"><RoadbookBrand /></div>
          <button className="hm-pill" onClick={() => setSearching(true)} aria-label={t('Search a place, or describe a ride')}>
            <SearchGlyph />
            <span>{t('Where do you want to ride?')}</span>
          </button>
          <button className={`hm-tripsbtn${drawer ? ' active' : ''}`} onClick={() => { setDrawer(!drawer); setPlace(null); setChip(null); }} aria-pressed={drawer}>{t('Your trips')} <span className="cnt">{cards.length}</span></button>
          <button className="hm-round" onClick={onSettings} aria-label={t('Settings')}><SettingsIcon /></button>
        </div>
        <div className="hm-chips" role="tablist">
          {CATEGORIES.map((c) => (
            <button key={c.id} role="tab" aria-selected={chip === c.id} className={`hm-chip${chip === c.id ? ' active' : ''}`}
              onClick={() => { setPlace(null); setChip(chip === c.id ? null : c.id); }}>
              <i aria-hidden="true">{c.glyph}</i> {t(c.label)}
            </button>
          ))}
        </div>
      </div>
      <button className="hm-round hm-locate" onClick={async () => { setFixTried(true); const f = await locate(); if (f) setFocus({ lat: f.lat, lng: f.lng, at: Date.now() }); }} aria-label={t('Near me')}><LocateGlyph /></button>
      {Math.abs(bearing) > 1 && (
        <button className="hm-round hm-north" onClick={() => { window.__homeMap?.resetNorth({ duration: 400 }); setBearing(0); }} aria-label={t('North up')} title={t('North up')}>
          <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
            <path d="M10 2 L13.5 11 L10 9.4 L6.5 11 Z" fill="#ff5a1f" />
            <path d="M10 18 L6.5 9 L10 10.6 L13.5 9 Z" fill="currentColor" opacity="0.85" />
          </svg>
        </button>
      )}
      {/* the same layers pill as the trip map, in the same corner */}
      <div className={`basemap-switch hm-layers${switchOpen ? '' : ' closed'}`}>
        <button className="bs-toggle" aria-expanded={switchOpen} title={t('Basemap')} onClick={() => setSwitchOpen((v) => !v)}>
          <svg viewBox="0 0 20 20" className="bs-ic" aria-hidden="true">
            <path d="M10 2.5 L17.5 7 L10 11.5 L2.5 7 Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="M3.6 10.4 L10 14.2 L16.4 10.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.65" />
            <path d="M3.6 13.6 L10 17.4 L16.4 13.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.35" />
          </svg>
          {!switchOpen && <span className="bs-cur">{BASEMAPS[basemap]?.label ?? '…'}{terrain3d ? ' · 3D' : ''}</span>}
        </button>
        {switchOpen && (
          <>
            {Object.entries(BASEMAPS).map(([key, b]) => (
              <button key={key} className={basemap === key ? 'active' : ''} onClick={() => { setBasemap(key); setSwitchOpen(false); }}>{b.label}</button>
            ))}
            <button className={terrain3d ? 'active' : ''} title="3D terrain" onClick={() => setTerrain3d((v) => !v)}>3D</button>
          </>
        )}
      </div>
      {fix && <div className="hm-near mono">{fix.name === 'Current location' ? t('Near you') : `${t('Near')} ${fix.name}`}</div>}

      {searching && (
        <HomeSearch
          near={near}
          onClose={() => setSearching(false)}
          onPlan={(q) => { setSearching(false); onNewTrip({ tab: 'ai', prompt: q }); }}
          onPick={(row) => { setSearching(false); setChip(null); showPlace(rowToPoi(row), row); }}
        />
      )}

      <div className={`hm-sheet${place ? ' place' : ''}${chip ? ' pick' : ''}${dragH ? ' dragging' : ''}${drawer || place || chip ? ' open' : ''}`} data-state={sheet} style={dragH ? { height: `${Math.round(dragH)}px` } : undefined}>
        <button className="hm-handle" aria-label={sheet === 'up' ? t('Show the map') : t('Show more')} onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}><i /><span className="hm-handle-txt">{sheet === 'up' ? t('Show the map') : <>{t('Your trips')}<span className="cnt">{cards.length}</span></>}</span></button>
        <div className="hm-body">
          {place ? (
            <HomePlaceCard
              poi={place.poi} row={place.row} fix={fix} defaults={quickDefaults}
              onRide={rideTo}
              onAdd={(p) => setAddTo(p)}
              onClose={() => setPlace(null)}
            />
          ) : chip ? (
            <NearbyPicker
              mode="add"
              near={near}
              routePrefs={quickDefaults?.routePrefs}
              initialCategory={chip}
              title={t('Find a place')}
              tapped={tapped}
              onRows={(rows, { fit }) => { setPins(rows); if (fit) setFitAt(Date.now()); }}
              onPick={(row) => showPlace(rowToPoi(row), row)}
              onClose={() => { setChip(null); setPins([]); }}
            />
          ) : (
            <>
              {fixErr && fixTried && <p className="nb-note hm-fixnote">{fixErr}</p>}
              {cards.length > 0 && (
                <section className="section hm-trips">
                  <h3>{t('Your trips')} <span className="cnt">{cards.length}</span></h3>
                  <div className={sheet === 'up' || drawer ? 'trip-grid' : 'hm-trips-row'}>
                    {cards.map(({ rec, grade, score, miles, dayCount, from, to, riders }) => (
                      <div key={rec.id} className={`trip-card${rec.id === lib.activeId ? ' active' : ''}`} role="button" tabIndex={0} aria-label={rec.name}
                        onClick={() => onOpenTrip(rec.id)} onKeyDown={(e) => { if (e.key === 'Enter') onOpenTrip(rec.id); }}>
                        <RouteSilhouette trip={rec.trip} height={54} />
                        <div className="tc-top">
                          <span className={`grade grade-${grade}`} title={`${score}/100`}>{grade}</span>
                          {cards.length > 1 && <button className="tc-del" title={t('Delete this trip')} onClick={(e) => { e.stopPropagation(); onDeleteTrip(rec); }}>✕</button>}
                        </div>
                        <div className="tc-name">{rec.name}</div>
                        <div className="tc-meta">{fmtLongDate(from)} → {fmtLongDate(to)}</div>
                        <div className="tc-meta">{dayCount} {t('days')} · {u.mi(miles)} · {riders} {t('riders')}</div>
                        <div className="tc-open">{rec.id === lib.activeId ? t('Continue planning →') : t('Open →')}</div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <InstallPrompt />
              {quickRides.length > 0 && (
                <section className="section">
                  <h3>{t('Quick rides')} <span className="cnt">{t('one-day rides from where you were — ride again, or make one a trip')}</span></h3>
                  <div className="quick-list">
                    {quickRides.map((rec) => (
                      <div key={rec.id} className="quick-row">
                        <div className="qr-name">{rec.name}<small>{rec.trip.days[0]?.date}</small></div>
                        <button className="btn" onClick={() => onRideAgain(rec.id)}>▶ {t('Ride')}</button>
                        <button className="btn" onClick={() => onPromoteQuick(rec.id)}>{t('Make it a trip')}</button>
                        <button className="tc-del" title={t('Delete')} onClick={() => onDeleteQuick(rec)}>✕</button>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {templates.length > 0 && (
                <section className="section">
                  <h3>{t('Your templates')} <span className="cnt">{t('saved starting points — copy one, or lay its days into a trip')}</span></h3>
                  <div className="trip-grid">
                    {templates.map((rec) => (
                      <div key={rec.id} className="trip-card tpl-card" role="button" tabIndex={0} onClick={() => onUseTemplate(rec.id)} onKeyDown={(e) => { if (e.key === 'Enter') onUseTemplate(rec.id); }}>
                        <RouteSilhouette trip={rec.trip} height={64} />
                        <div className="tc-top">
                          <span className="tpl-tag">{t('Template')}</span>
                          <button className="tc-del" title={t('Delete this template')} onClick={(e) => { e.stopPropagation(); onDeleteTemplate(rec); }}>✕</button>
                        </div>
                        <div className="tc-name">{rec.name}</div>
                        <div className="tc-meta">{rec.trip.days.length} {t('days')}{rec.trip.meta?.templateNote ? ` · ${rec.trip.meta.templateNote}` : ''}</div>
                        <div className="tc-actions">
                          <button className="tc-open" onClick={(e) => { e.stopPropagation(); onUseTemplate(rec.id); }}>{t('Use it →')}</button>
                          <button className="tc-share" onClick={(e) => { e.stopPropagation(); onShareTemplate(rec); }}>{t('Share')}</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section className="section">
                <h3>{t('Start from')}</h3>
                <div className="trip-grid start-grid">
                  <div className="trip-card start-card" role="button" tabIndex={0} onClick={() => onNewTrip({ tab: 'template', templateId: 'seed' })} onKeyDown={(e) => { if (e.key === 'Enter') onNewTrip({ tab: 'template', templateId: 'seed' }); }}>
                    <RouteSilhouette trip={SEED_TRIP} height={64} />
                    <div className="tc-name">{SEED_TRIP.meta.title}</div>
                    <div className="tc-meta">{SEED_TRIP.days.length} {t('days')} · {t('the full field guide')}</div>
                    <div className="tc-open">{t('Copy it →')}</div>
                  </div>
                  <div className="trip-card start-card" role="button" tabIndex={0} onClick={() => onNewTrip({ tab: 'template', templateId: 'early-exit' })} onKeyDown={(e) => { if (e.key === 'Enter') onNewTrip({ tab: 'template', templateId: 'early-exit' }); }}>
                    <RouteSilhouette trip={EARLY_EXIT_TRIP} height={64} />
                    <div className="tc-name">{EARLY_EXIT_TRIP.meta.title}</div>
                    <div className="tc-meta">{EARLY_EXIT_TRIP.days.length} {t('days')} · {t('the long way home from the rally')}</div>
                    <div className="tc-open">{t('Copy it →')}</div>
                  </div>
                  <div className="trip-card start-card" role="button" tabIndex={0} onClick={() => onNewTrip({ tab: 'blank' })} onKeyDown={(e) => { if (e.key === 'Enter') onNewTrip({ tab: 'blank' }); }}>
                    <RouteSilhouette trip={{ days: [] }} height={64} />
                    <div className="tc-name">{t('Blank trip')}</div>
                    <div className="tc-meta">{t('An empty frame — add days and stops by hand')}</div>
                    <div className="tc-open">{t('Start empty →')}</div>
                  </div>
                  <div className="trip-card start-card" role="button" tabIndex={0} onClick={onImport} onKeyDown={(e) => { if (e.key === 'Enter') onImport(); }}>
                    <RouteSilhouette trip={{ days: [] }} height={64} />
                    <div className="tc-name">{t('Import JSON')}</div>
                    <div className="tc-meta">{t('A trip file from a riding buddy')}</div>
                    <div className="tc-open">{t('Load it →')}</div>
                  </div>
                  <div className="trip-card start-card guide-card" role="button" tabIndex={0} onClick={onHelp} onKeyDown={(e) => { if (e.key === 'Enter') onHelp(); }}>
                    <div className="gc-mark" aria-hidden="true">?</div>
                    <div className="tc-name">{t('How to use Roadbook')}</div>
                    <div className="tc-meta">{t('Step-by-step directions and walkthrough videos')}</div>
                    <div className="tc-open">{t('Open the guide →')}</div>
                  </div>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      {addTo && (
        <AddToTripSheet
          place={addTo}
          trips={trips}
          onClose={() => setAddTo(null)}
          onPick={(tripId, dayId) => { setAddTo(null); onAddToTrip({ tripId, dayId, place: addTo }); }}
          onNew={() => { setAddTo(null); onNewTrip({ tab: 'ai', prompt: `${t('A ride that includes')} ${addTo.name}${addTo.detail ? ` (${addTo.detail})` : ''}` }); }}
        />
      )}
    </div>
  );
}

// The place the rider tapped or picked, as the sheet's card. A vector POI is
// resolved against Google the way the plan map's card does it; a picker or
// search row is already Google's.
function HomePlaceCard({ poi, row, fix, onRide, onAdd, onClose, defaults }) {
  const t = useT();
  const u = useUnits();
  const looked = usePoiMatch(row ? null : poi);
  // Ride here opens the one thing a map app will not offer a motorcyclist —
  // the Roads choice — as a one-line strip, then Go
  const [confirm, setConfirm] = useState(false);
  const [style, setStyle] = useState(defaults?.routePrefs?.style ?? 'touring');
  const [avoidTolls, setAvoidTolls] = useState(!!defaults?.routePrefs?.avoidTolls);
  const match = row ?? looked;
  const natural = !row && poiIsNatural(poi.cls, poi.subclass); // a peak, a pass, a forest: a placed pin, never a lookup
  const cat = poiCategory(poi.cls, poi.subclass) ?? (match?.primaryType?.includes('gas') ? 'fuel' : null);
  const glyph = row ? (CATEGORIES.find((c) => c.id === poiCategory(row.primaryType, row.primaryType))?.glyph ?? '📍') : poiGlyph(poi.cls, poi.subclass);
  const [details, setDetails] = useState(false);
  const place = match
    ? { ...match, name: match.name, lat: match.lat, lng: match.lng, detail: match.detail, placeId: match.id, id: match.id, source: 'google', verified: 'google' }
    : { name: poi.name, lat: poi.lat, lng: poi.lng, detail: '', source: 'osm', ...(natural ? { placed: 'rider', kind: 'photo' } : {}) };
  const elev = poi.elevFt ? (u.metric ? `${Math.round(poi.elevFt / 3.28084)} m` : `${poi.elevFt.toLocaleString()} ft`) : '';
  const kicker = [match && cat === 'food' ? cuisineLabel(match.primaryType, match.types) : '', elev, poi.subclass || poi.cls].filter(Boolean).join(' · ').replace(/_/g, ' ');
  const dist = fix ? `${u.miNum(haversineMiles(fix, poi))} ${u.miUnit} ${t('from you')}` : '';
  const hours = Array.isArray(match?.hours) && match.hours.length ? match.hours : null;
  return (
    <div className="hm-place" role="dialog" aria-label={place.name}>
      <div className="hm-place-head">
        <span className="poi-glyph" aria-hidden="true">{glyph}</span>
        <div className="poi-title"><b>{place.name}</b><small><span className="hm-kicker">{kicker}</span>{kicker && dist ? ' · ' : ''}<span className="hm-dist">{dist}</span></small></div>
        <button className="mini-edit" onClick={onClose} aria-label={t('Close')}>✕</button>
      </div>
      <div className="poi-facts">
        {natural && <span className="nb-note">{t('A place on the map, not a listed business — it will be added as a placed pin.')}</span>}
        {!natural && match === undefined && <span className="nb-note">{t('Checking with Google…')}</span>}
        {!natural && match === null && <span className="nb-note">{t('No Google listing found here — it will be added as an unverified stop.')}</span>}
        {match && (
          <>
            {Number.isFinite(match.rating) && <span className="nb-rate">★ {match.rating.toFixed(1)}{match.userRatingCount ? <small> ({match.userRatingCount})</small> : null}</span>}
            {priceGlyph(match.priceLevel) && <span className="nb-price">{priceGlyph(match.priceLevel)}</span>}
            {match.openNow != null && <span className={`nb-open ${match.openNow ? 'ok' : 'bad'}`}>{match.openNow ? t('Open now') : t('Closed now')}</span>}
            {hours && <span className="ps-today">{t('Today')} {hoursOnly(hours[todayIndex()])}</span>}
            <span className="nb-ver">✓ {t('Google')}</span>
          </>
        )}
      </div>
      {confirm ? (
        <section className="quick-ride hm-ride-confirm">
          <div className="qk-prefs">
            <div className="qk-roads" role="radiogroup" aria-label={t('Roads')}>
              {[['quick', t('Quick')], ['touring', t('Touring')], ['backroads', t('Back roads')]].map(([id, label]) => (
                <button key={id} role="radio" aria-checked={style === id} className={style === id ? 'active' : ''} onClick={() => setStyle(id)}>{label}</button>
              ))}
            </div>
            <label className="qk-tolls"><input type="checkbox" checked={avoidTolls} onChange={(e) => setAvoidTolls(e.target.checked)} /> {t('Avoid tolls')}</label>
          </div>
          <div className="hm-place-actions">
            <button className="btn gold" onClick={() => onRide(place, { style, avoidTolls })}>▶ {t('Go')}</button>
            <button className="btn" onClick={() => setConfirm(false)}>{t('Back')}</button>
          </div>
        </section>
      ) : (
        <div className="hm-place-actions">
          <button className="btn gold" disabled={match === undefined} onClick={() => setConfirm(true)}>{t('Ride here')}</button>
          <button className="btn" disabled={match === undefined} onClick={() => onAdd(place)}>{t('Add to a trip')}</button>
          {match && <button className="btn" onClick={() => setDetails(true)}>{t('Details')}</button>}
        </div>
      )}
      {details && (
        <PlaceSheet
          place={place} glyph={glyph} kicker={kicker}
          facts={dist ? <span className="nb-note">{dist}</span> : null}
          onClose={() => setDetails(false)}
          actions={(<><button className="btn gold" onClick={() => { setDetails(false); setConfirm(true); }}>{t('Ride here')}</button><button className="btn" onClick={() => { setDetails(false); onAdd(place); }}>{t('Add to a trip')}</button></>)}
        />
      )}
    </div>
  );
}

// The pill, opened: a place name searches the map near you; a sentence is a
// plan and the builder opens with it — the same words, both doors.
function HomeSearch({ near, onClose, onPlan, onPick }) {
  const t = useT();
  const u = useUnits();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const timer = useRef(null);
  const recent = useMemo(loadRecent, []);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    clearTimeout(timer.current);
    const text = q.trim();
    if (text.length < 2 || readsAsPlan(text)) { setRows([]); return undefined; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try { setRows(await searchNearby({ category: null, query: text, near, radiusMi: 150, limit: 6 })); } catch { setRows([]); }
      setBusy(false);
    }, 350);
    return () => clearTimeout(timer.current);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = q.trim().length > 0 && readsAsPlan(q);
  return (
    <div className="hm-search" role="dialog" aria-label={t('Search a place, or describe a ride')}>
      <div className="hm-pillrow">
        <button className="hm-round" onClick={onClose} aria-label={t('Back')}>‹</button>
        <input ref={inputRef} className="hm-input" value={q} placeholder={t('Search a place, or describe a ride')} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && plan) onPlan(q.trim()); }} />
      </div>
      {q.trim().length > 0 && (
        <button className={`hm-ai${plan ? ' lead' : ''}`} onClick={() => onPlan(q.trim())}>
          <span className="hm-ai-glyph" aria-hidden="true">✦</span>
          <span><b>{plan ? t('Plan this ride with AI') : `${t('Plan a trip to')} ${q.trim()} ${t('with AI')}`}</b><small>{t('Or keep typing a sentence — riders, days, pace — and the builder opens with it.')}</small></span>
        </button>
      )}
      {(rows.length > 0 || busy) && (
        <ul className="hm-results">
          {busy && rows.length === 0 && <li className="nb-note">{t('Searching…')}</li>}
          {rows.map((r) => (
            <li key={r.id}><button onClick={() => onPick(r)}>
              <span className="hm-res-pin" aria-hidden="true">◎</span>
              <span className="hm-res-main"><b>{r.name}</b><small>{[r.detail, Number.isFinite(r.lat) ? `${u.miNum(haversineMiles(near, r))} ${u.miUnit}` : ''].filter(Boolean).join(' · ')}</small></span>
              <span className="mono hm-res-go">{t('Show')}</span>
            </button></li>
          ))}
        </ul>
      )}
      {q.trim().length === 0 && (
        <button className="hm-ai lead" onClick={() => onPlan('')}>
          <span className="hm-ai-glyph" aria-hidden="true">✦</span>
          <span><b>{t('Plan a trip with AI')}</b><small>{t('Describe riders, days, region and pace — or just type a place name to ride there.')}</small></span>
        </button>
      )}
      {q.trim().length === 0 && recent.length > 0 && (
        <>
          <div className="mono hm-label">{t('Recent')}</div>
          <ul className="hm-results">
            {recent.map((r) => (
              <li key={r.name}><button onClick={() => onPick({ ...r, id: null })}><span className="hm-res-main"><b>{r.name}</b><small>{r.detail}</small></span></button></li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// Which trip, which day: trips ranked by how close their route passes the
// place, the nearest day pre-picked; or a new trip that includes it.
function AddToTripSheet({ place, trips, onClose, onPick, onNew }) {
  const t = useT();
  const u = useUnits();
  const ranked = useMemo(() => trips.map((rec) => {
    let best = null;
    for (const day of rec.trip.days) {
      for (const w of day.waypoints) {
        const d = haversineMiles(place, w);
        if (!best || d < best.d) best = { d, day };
      }
    }
    return { rec, best };
  }).filter((x) => x.best).sort((a, b) => a.best.d - b.best.d), [trips, place]);
  return (
    <Sheet title={`${t('Add')} ${place.name} ${t('to…')}`} eyebrow={t('It lands by route order on the day you pick')} onClose={onClose}>
      <div className="hm-addto">
        {ranked.map(({ rec, best }, i) => (
          <button key={rec.id} className={`hm-addto-row${i === 0 ? ' lead' : ''}`} onClick={() => onPick(rec.id, best.day.id)}>
            <span className="hm-addto-main"><b>{rec.name}</b><small>{t('Nearest day')} {best.day.dow} {best.day.date?.slice(5)} · {best.day.title} · {u.miNum(best.d)} {u.miUnit} {t('from a stop')}</small></span>
            <span className="mono hm-res-go">{best.day.dow} {best.day.date?.slice(5)}</span>
          </button>
        ))}
        <button className="hm-addto-row new" onClick={onNew}>
          <span className="hm-addto-main"><b>{t('New trip with AI that includes this place')}</b></span>
          <span className="mono hm-res-go">✦</span>
        </button>
      </div>
    </Sheet>
  );
}

const SearchGlyph = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;
const LocateGlyph = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" fill="currentColor" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>;

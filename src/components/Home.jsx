import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { hoursOnly, todayIndex, reverseGeocode, coordLabel } from '../engine/places.js';
import InstallPrompt from './InstallPrompt.jsx';
import NearbyPicker from './NearbyPicker.jsx';
import { useIsMobile } from '../hooks/useMediaQuery.js';
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
// The sheet's three positions, per surface. The picker peeks taller than the
// trips row because it has to hold chips, a cuisine row, a field and a list;
// the place card is shorter. Every surface answers every detent — the CSS
// matrix in app.css is the same table, and the handle can always drop any of
// them to `min` so the map is the screen.
const SHEET_PX = { min: 0.06, peek: 0.42, up: 0.86 };
const SURFACE_PX = {
  pick: { min: 0.06, peek: 0.72, up: 0.92 },
  place: { min: 0.06, peek: 0.46, up: 0.86 },
};
const detentsFor = (surface) => SURFACE_PX[surface] ?? SHEET_PX;
const DETENTS = ['min', 'peek', 'up'];
const nearestDetent = (frac, px = SHEET_PX) => DETENTS.reduce((best, k) => (Math.abs(px[k] - frac) < Math.abs(px[best] - frac) ? k : best), 'peek');

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

  // The rider ON the map (owner, Sep 13 2026: "When I click the locate button
  // it never shows the locator dot of me and if possible direction facing"):
  // a live watch while Home is open — cheap, and it is what makes the dot
  // move — plus the compass once the locate button has been tapped (iOS only
  // grants DeviceOrientation from a user gesture). GPS course counts only when
  // moving; standing still, the compass says which way the bike points.
  const [live, setLive] = useState(null);       // { lat, lng, accuracy, heading|null } from watchPosition
  const [compass, setCompass] = useState(null); // degrees clockwise from north, or null
  useEffect(() => {
    if (!navigator.geolocation?.watchPosition) return undefined;
    let id;
    try {
      id = navigator.geolocation.watchPosition(
        (p) => setLive({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: Number.isFinite(p.coords.heading) && (p.coords.speed ?? 0) > 1 ? p.coords.heading : null }),
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000 },
      );
    } catch { return undefined; }
    return () => { try { navigator.geolocation.clearWatch(id); } catch {} };
  }, []);
  const compassOn = useRef(false);
  const startCompass = async () => {
    if (compassOn.current || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return;
      }
    } catch { return; }
    compassOn.current = true;
    let last = 0;
    const onOrient = (e) => {
      const now = Date.now();
      if (now - last < 120) return; // ~8 Hz is plenty for a cone
      last = now;
      const h = Number.isFinite(e.webkitCompassHeading) ? e.webkitCompassHeading : (e.absolute && Number.isFinite(e.alpha) ? (360 - e.alpha) % 360 : null);
      if (h != null) setCompass(h);
    };
    window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
  };
  const me = useMemo(() => {
    const p = live ?? (fix && fix.name === 'Current location' ? fix : null);
    if (!p) return null;
    return { lat: p.lat, lng: p.lng, accuracy: p.accuracy, heading: live?.heading ?? compass ?? null };
  }, [live, fix, compass]);
  const goToMe = async () => {
    setFixTried(true);
    startCompass();
    const f = await locate();
    if (f) setFocus({ lat: f.lat, lng: f.lng, at: Date.now() });
  };

  const [sheet, setSheet] = useState('peek'); // min | peek | up
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
  // release; a tap (no travel) steps up, and steps back down from the top.
  //
  // The drag is written straight onto the sheet element — height inline,
  // `data-drag` for the transition-off rule — rather than through state: a
  // setState per pointermove re-rendered the whole home (map props, pins, the
  // trips grid) sixty times a second, which is what made the sheet judder
  // under the finger and the fab column trail it. React owns neither of those
  // two attributes, so a re-render mid-drag cannot clobber them.
  const dragTo = (h) => {
    const el = sheetRef.current;
    if (!el) return;
    el.dataset.drag = '1';
    el.style.height = `${Math.round(h)}px`;
  };
  const dragEnd = () => {
    const el = sheetRef.current;
    if (!el) return;
    delete el.dataset.drag;
    el.style.height = '';
  };
  const onHandleDown = (e) => {
    const vh = window.innerHeight;
    dragRef.current = { y0: e.clientY, h0: vh * detentsFor(surfaceRef.current)[sheet], vh, moved: false, id: e.pointerId };
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* a synthetic pointer has no capture */ }
  };
  const onHandleMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = d.y0 - e.clientY;
    if (Math.abs(dy) > 6) d.moved = true;
    if (d.moved) dragTo(Math.max(d.vh * 0.1, Math.min(d.vh * 0.92, d.h0 + dy)));
  };
  const onHandleUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    dragEnd();
    if (!d) return;
    if (!d.moved) { setSheet((s) => (s === 'min' ? 'peek' : 'min')); return; }
    setSheet(nearestDetent(Math.max(d.vh * 0.1, Math.min(d.vh * 0.92, d.h0 + (d.y0 - e.clientY))) / d.vh, detentsFor(surfaceRef.current)));
  };
  const [chip, setChip] = useState(null);      // a category → the picker in the sheet
  const [pins, setPins] = useState([]);
  const [fitAt, setFitAt] = useState(0);
  const [tapped, setTapped] = useState(null);
  const [place, setPlace] = useState(null);    // { poi, row? } → the place card
  const [focus, setFocus] = useState(null);
  const [center, setCenter] = useState(null); // where the map is looking — the chips and the search look there too
  const [view, setView] = useState(null);     // the map's bounds after every move (frame-my-trips hides while a trip is in view)
  const [moved, setMoved] = useState(false);  // a hand pan since the picker's last result set → "Search this area"
  const [area, setArea] = useState(null);     // the chip pressed: the picker searches the map centre
  const onCenter = (c, { bounds, hand } = {}) => { if (c) setCenter(c); if (bounds) setView(bounds); if (hand) setMoved(true); };
  const [searching, setSearching] = useState(false);
  // phone vs desktop: the search is a full screen or a dropdown under the pill
  const isPhone = useIsMobile();
  const [addTo, setAddTo] = useState(null);    // a place → which trip?
  const surface = place ? 'place' : chip ? 'pick' : null;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const sheetPx = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * detentsFor(surface)[sheet]);
  // The fab column floats off the sheet's REAL height, not the detent fraction:
  // at `min` the sheet is the handle plus the phone's home-indicator inset
  // (56 + 34px on an iPhone), while 6% of the viewport is ~52px — so the
  // locate button sat under the handle and every tap at it opened the sheet.
  //
  // That height is written STRAIGHT onto the root as `--hm-sheet` from the
  // ResizeObserver, never through React state (Sep 14, 2026 — owner: "there's
  // a lag on the locator buttons on side when you expand bottom and it lags
  // the bottom trips tab"). The observer fires on every frame of the sheet's
  // own height transition, so a setState there re-rendered the whole home —
  // map props, pins, the trips grid — sixty times a second while the sheet
  // was moving: the column arrived a frame or more late and the sheet's own
  // animation juddered. A style property set inside the observer callback
  // lands in the SAME frame's paint, before React is involved at all.
  const rootRef = useRef(null);
  const sheetRef = useRef(null);
  const roRef = useRef(false);
  useLayoutEffect(() => {
    const root = rootRef.current, el = sheetRef.current;
    if (!root || !el) return;
    const write = () => root.style.setProperty('--hm-sheet', `${Math.round(el.getBoundingClientRect().height)}px`);
    write(); // before the first paint, so the column never starts at 0
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(write);
    ro.observe(el);
    roRef.current = true;
    return () => { ro.disconnect(); roRef.current = false; };
  }, []);
  // a browser with no ResizeObserver still gets the detent it just moved to
  useLayoutEffect(() => {
    if (roRef.current || !rootRef.current || !sheetRef.current) return;
    rootRef.current.style.setProperty('--hm-sheet', `${Math.round(sheetRef.current.getBoundingClientRect().height)}px`);
  }, [sheet, surface]);
  // The handle says what pressing it does, for whatever is in the sheet. It read
  // "Your trips · 4" over an open Find-a-place picker before, which named the
  // wrong surface and the wrong action at the same time.
  const handle = (() => {
    if (sheet !== 'min') return { label: t('Show the map'), aria: t('Show the map') };
    if (surface === 'pick') {
      const n = pins.length;
      return {
        label: <>{t('Show the list')}{n ? <span className="cnt">{n}</span> : null}</>,
        aria: t('Show the list'),
      };
    }
    if (surface === 'place') return { label: t('Show the place'), aria: t('Show the place') };
    return {
      label: <>{t('Your trips')}<span className="cnt">{cards.length}</span></>,
      aria: t('Your trips'),
    };
  })();
  const near = center ?? fix ?? home ?? { lat: 45.9, lng: -108.5 };
  // every stop of every trip in the library — the extent "Frame my trips" flies to
  const tripPts = useMemo(() => trips.flatMap((rec) => rec.trip.days.flatMap((d) => d.waypoints.map((w) => [w.lng, w.lat]))).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), [trips]);
  const tripsOffscreen = tripPts.length > 0 && !!view && !tripPts.some(([x, y]) => x >= view[0][0] && x <= view[1][0] && y >= view[0][1] && y <= view[1][1]);
  const frameTrips = () => {
    const map = window.__homeMap;
    if (!map || !tripPts.length) return;
    const xs = tripPts.map((p) => p[0]), ys = tripPts.map((p) => p[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 150, bottom: sheetPx + 24, left: 32, right: 72 }, duration: 700, maxZoom: 11 });
  };

  // The sheet only ever RISES for the rider's own tap on the handle. A card or
  // a picker that needs room lifts a minimised sheet to peek for its own sake,
  // and puts it back where it was when it closes (owner: "when you exit out
  // it expands the trips tab… it should stay lowered").
  const sheetBeforeRaise = useRef(null);
  const raiseFor = () => setSheet((s) => { if (s !== 'min') return s; if (sheetBeforeRaise.current == null) sheetBeforeRaise.current = s; return 'peek'; });
  const lowerAfter = () => { if (sheetBeforeRaise.current != null) { setSheet(sheetBeforeRaise.current); sheetBeforeRaise.current = null; } };
  const showPlace = (poi, row = null) => {
    setPlace({ poi, row });
    // a card born behind the handle is no card: a minimised sheet (a dropped
    // pin forces `min`; a rider can too) comes up to the card's own peek and
    // goes back down when the card closes. The drop path restores its own.
    raiseFor();
    setFocus({ lat: poi.lat, lng: poi.lng, at: Date.now() });
    if (row) pushRecent({ name: row.name, lat: row.lat, lng: row.lng, detail: row.detail ?? '' });
  };
  const rowToPoi = (r) => ({ name: r.name, lat: r.lat, lng: r.lng, cls: r.primaryType ?? '', subclass: r.primaryType ?? '' });
  // A long press (or right-click) on open map drops a PIN — a needle on the
  // exact spot with the wheel around it (the RouteWheel grammar: adjust and
  // confirm are separate acts). The rider drags it onto the pullout they
  // meant, reads the coordinate and the road as it resolves, and ✓ opens the
  // same card as a tapped place, as a PLACED spot — the rider's own
  // coordinate, never dressed up as a listing — with Ride here / Add to a
  // trip. ✕, or a tap on open map, takes the pin away. A plain tap never
  // drops one.
  const [dropped, setDropped] = useState(null); // { key, lat, lng, name, detail }
  const geoTimer = useRef(null);
  const nameDrop = (key, pt) => {
    clearTimeout(geoTimer.current);
    geoTimer.current = setTimeout(() => {
      reverseGeocode(pt, { near: t('Near') }).then((g) => {
        if (!g) return;
        setDropped((d) => (d && d.key === key && d.lat === pt.lat && d.lng === pt.lng ? { ...d, name: g.name, detail: g.detail ?? '' } : d));
        // the card, if it is already up on this pin, learns the name too
        setPlace((cur) => (cur?.poi?.placed && cur.poi.lat === pt.lat && cur.poi.lng === pt.lng ? { ...cur, poi: { ...cur.poi, name: g.name, detail: g.detail ?? '' } } : cur));
      });
    }, 350);
  };
  const sheetBeforeDrop = useRef(null);
  const dropPin = (pt) => {
    const key = Date.now();
    setChip(null); setPins([]); setPlace(null);
    // the map is the screen while a pin is being placed: the sheet drops to
    // its handle (a peeking sheet plus the readout plus the wheel do not fit
    // one phone screen) and comes back where it was when the pin goes
    setSheet((cur) => { if (sheetBeforeDrop.current == null) sheetBeforeDrop.current = cur; return 'min'; });
    setDropped({ key, lat: pt.lat, lng: pt.lng, name: null, detail: '' });
    setFocus({ lat: pt.lat, lng: pt.lng, at: key });
    nameDrop(key, pt);
  };
  const moveDrop = ([lng, lat]) => setDropped((d) => (d ? { ...d, lat, lng, name: null, detail: '' } : d));
  const settleDrop = ([lng, lat]) => setDropped((d) => { if (d) nameDrop(d.key, { lat, lng }); return d; });
  const confirmDrop = () => {
    if (!dropped) return;
    showPlace({ name: dropped.name ?? coordLabel(dropped), lat: dropped.lat, lng: dropped.lng, cls: '', subclass: '', placed: 'rider', detail: dropped.detail ?? '' });
  };
  const cancelDrop = () => {
    clearTimeout(geoTimer.current); setDropped(null); setPlace((p) => (p?.poi?.placed ? null : p));
    if (sheetBeforeDrop.current != null) { setSheet(sheetBeforeDrop.current); sheetBeforeDrop.current = null; }
  };
  const dropReadout = dropped ? `${dropped.name ?? coordLabel(dropped, 5)}${dropped.name ? ` · ${coordLabel(dropped, 5)}` : ''}` : '';

  // start: a chosen place, or (undefined) where the rider is — the card's From row
  const rideTo = async (dest, prefs, start) => {
    start = start ?? fix ?? (await locate());
    if (!start) return;
    onQuickRide({ start, dest, routePrefs: { style: prefs?.style ?? quickDefaults?.routePrefs?.style ?? 'touring', avoidTolls: prefs?.avoidTolls ?? !!quickDefaults?.routePrefs?.avoidTolls } });
  };

  return (
    <div ref={rootRef} className="home home-map">
      <HomeMap
        fix={fix} me={me}
        focus={focus}
        // the card's place is a pin too: a searched place showed a card with
        // nothing on the map where it was (owner: "when I look up a location
        // it doesn't drop a pin"). A place TAPPED on the map is already drawn
        // by the map, so it gets a halo around the basemap's own icon rather
        // than a second, bigger one on top (owner: "what's the point of
        // creating a bigger Whole Foods icon rather than just emphasizing the
        // one already on the map"). The picker's pins win while they are up,
        // and a dropped needle is its own marker.
        pins={pins.length || dropped ? pins : place && !place.poi.placed ? [{ id: 'place', lat: place.poi.lat, lng: place.poi.lng, name: place.poi.name, glyph: place.row ? (CATEGORIES.find((c) => c.id === poiCategory(place.row.primaryType, place.row.primaryType))?.glyph ?? '📍') : poiGlyph(place.poi.cls, place.poi.subclass), cat: place.row ? poiCategory(place.row.primaryType, place.row.primaryType) : poiCategory(place.poi.cls, place.poi.subclass), hot: true, halo: !place.row }] : []}
        fitAt={fitAt}
        sheetPx={sheetPx}
        drop={dropped}
        onPinTap={(id) => setTapped({ id, at: Date.now() })}
        onCenter={onCenter}
        onBearing={setBearing}
        basemap={basemap}
        terrain3d={terrain3d}
        onDrop={dropPin}
        onDropMove={moveDrop}
        onDropMoveEnd={settleDrop}
        onDropConfirm={confirmDrop}
        onDropCancel={cancelDrop}
        dropLabel={t('Use this spot')}
        onPoi={(poi) => { if (poi) showPlace(poi); else if (dropped) cancelDrop(); else if (place) { setPlace(null); lowerAfter(); } else if (!chip) stepDown(); }} // a tap on open map: the pin goes, the card closes, or the sheet steps down
      />

      <div className={`hm-top${searching && !isPhone ? ' searching' : ''}`}>
        <div className="hm-pillrow">
          <div className="hm-brand" aria-hidden="true"><RoadbookBrand beta /></div>
          {/* on a desktop the pill becomes the field and its answers drop down under it */}
          {searching && !isPhone ? (
            <HomeSearch
              variant="dropdown"
              near={near}
              onClose={() => setSearching(false)}
              onPlan={(q) => { setSearching(false); onNewTrip({ tab: 'ai', prompt: q }); }}
              onPick={(row) => { setSearching(false); setChip(null); showPlace(rowToPoi(row), row); }}
            />
          ) : (
            <button className="hm-pill" onClick={() => setSearching(true)} aria-label={t('Search a place, or describe a ride')}>
              <SearchGlyph />
              <span>{t('Where do you want to ride?')}</span>
            </button>
          )}
          <button className={`hm-tripsbtn${drawer ? ' active' : ''}`} onClick={() => { setDrawer(!drawer); setPlace(null); setChip(null); }} aria-pressed={drawer}>{t('Your trips')} <span className="cnt">{cards.length}</span></button>
          <button className="hm-round" onClick={onSettings} aria-label={t('Settings')}><SettingsIcon /></button>
        </div>
        <div className="hm-chips" role="tablist">
          {/* Coffee stays a category in the picker and the mid-ride quick add; the
              home map's strip is the six a rider looks for from the front door
              (owner, Sep 13 2026: "Remove the coffee stop chip from the map") */}
          {CATEGORIES.filter((c) => c.id !== 'coffee').map((c) => (
            <button key={c.id} role="tab" aria-selected={chip === c.id} className={`hm-chip${chip === c.id ? ' active' : ''}`}
              onClick={() => { setPlace(null); const open = chip !== c.id; setChip(open ? c.id : null); if (open) raiseFor(); else lowerAfter(); }}>
              <i aria-hidden="true">{c.glyph}</i> {t(c.label)}
            </button>
          ))}
        </div>
      </div>
      {/* the bottom-right column, floating above the sheet: frame my trips (only while none is in view) · North up (only while turned) · locate */}
      <div className="hm-fabs">
        {tripsOffscreen && (
          <button className="hm-round hm-frame" onClick={frameTrips} aria-label={t('Frame my trips')} title={t('Frame my trips')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4" /><path d="M7 14c2-4 4-6 6-4s3 4 4 2" /></svg>
          </button>
        )}
        {Math.abs(bearing) > 1 && (
          <button className="hm-round hm-north" onClick={() => { window.__homeMap?.resetNorth({ duration: 400 }); setBearing(0); }} aria-label={t('North up')} title={t('North up')}>
            <svg viewBox="0 0 20 20" width="22" height="22" aria-hidden="true" style={{ transform: `rotate(${-bearing}deg)` }}>
              <path d="M10 2 L13.5 11 L10 9.4 L6.5 11 Z" fill="#ff5a1f" />
              <path d="M10 18 L6.5 9 L10 10.6 L13.5 9 Z" fill="currentColor" opacity="0.85" />
            </svg>
          </button>
        )}
        <button className="hm-round hm-locate" onClick={goToMe} aria-label={t('Near me')}><LocateGlyph /></button>
      </div>
      {chip && moved && !place && (
        <button className="map-area-btn hm-area" onClick={() => { setArea({ ...near, at: Date.now() }); setMoved(false); }}>{t('Search this area')}</button>
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
      {dropped
        ? <div className="hm-drop-hint mono" role="status" aria-live="polite">◎ <b>{dropReadout}</b> · {t('drag the pin to adjust')} · {t('✓ to use it')}</div>
        : fix && <button type="button" className="hm-near mono" onClick={goToMe} title={t('Near me')}>{fix.name === 'Current location' ? t('Near you') : `${t('Near')} ${fix.name}`}</button>}

      {/* the phone's search is a screen of its own; the desktop's hangs under the pill (above) */}
      {searching && isPhone && (
        <HomeSearch
          near={near}
          onClose={() => setSearching(false)}
          onPlan={(q) => { setSearching(false); onNewTrip({ tab: 'ai', prompt: q }); }}
          onPick={(row) => { setSearching(false); setChip(null); showPlace(rowToPoi(row), row); }}
        />
      )}

      <div ref={sheetRef} className={`hm-sheet${place ? ' place' : ''}${chip ? ' pick' : ''}${drawer || place || chip ? ' open' : ''}`} data-state={sheet}>
        <button
          className="hm-handle"
          aria-label={handle.aria}
          aria-expanded={sheet !== 'min'}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
        ><i /><span className="hm-handle-txt">{handle.label}</span></button>
        <div className="hm-body">
          {place ? (
            <HomePlaceCard
              poi={place.poi} row={place.row} fix={fix} defaults={quickDefaults}
              onRide={rideTo}
              onAdd={(p) => setAddTo(p)}
              onClose={() => { setPlace(null); if (place.poi.placed) cancelDrop(); else lowerAfter(); }}
            />
          ) : chip ? (
            <NearbyPicker
              inlineDetail
              mode="add"
              near={near}
              routePrefs={quickDefaults?.routePrefs}
              initialCategory={chip}
              title={t('Find a place')}
              tapped={tapped}
              area={area}
              onRows={(rows, { fit }) => { setPins(rows); if (fit) { setFitAt(Date.now()); setMoved(false); } }}
              onPick={(row) => showPlace(rowToPoi(row), row)}
              onClose={() => { setChip(null); setPins([]); setArea(null); setMoved(false); lowerAfter(); }}
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
  // On a desktop the drawer opens straight onto the place's full page: there is
  // room, and a card whose main job was leading to Details was one click too
  // many (owner, Sep 14 2026: "why not just show full details for it to begin
  // with?"). A phone keeps the compact card at the sheet's peek.
  const isPhone = useIsMobile();
  const placed = poi.placed ?? null; // a dropped pin: nothing to look up, nothing to verify
  const looked = usePoiMatch(row || placed ? null : poi);
  // Ride here opens the one thing a map app will not offer a motorcyclist —
  // the Roads choice — as a one-line strip, then Go
  const [confirm, setConfirm] = useState(false);
  // From → To, like a directions sheet: From is where the rider is unless they
  // pick a place; ⇅ swaps the two (ride home from here, plan the return leg)
  const [from, setFrom] = useState(null);        // null = the rider's fix; else { name, lat, lng, placeId? }
  const [swapped, setSwapped] = useState(false); // the tapped place is the START and From is the destination
  const [fromEdit, setFromEdit] = useState(false);
  const [fromQ, setFromQ] = useState('');
  const [fromRows, setFromRows] = useState([]);
  useEffect(() => {
    if (!fromEdit || fromQ.trim().length < 2) { setFromRows([]); return undefined; }
    let dead = false;
    const id = setTimeout(async () => {
      try { const rows = await searchNearby({ category: null, query: fromQ.trim(), near: { lat: poi.lat, lng: poi.lng }, radiusMi: 150, limit: 5 }); if (!dead) setFromRows(rows); } catch { if (!dead) setFromRows([]); }
    }, 350);
    return () => { dead = true; clearTimeout(id); };
  }, [fromQ, fromEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const [style, setStyle] = useState(defaults?.routePrefs?.style ?? 'touring');
  const [avoidTolls, setAvoidTolls] = useState(!!defaults?.routePrefs?.avoidTolls);
  const match = placed ? null : (row ?? looked);
  const natural = !row && !placed && poiIsNatural(poi.cls, poi.subclass); // a peak, a pass, a forest: a placed pin, never a lookup
  const cat = poiCategory(poi.cls, poi.subclass) ?? (match?.primaryType?.includes('gas') ? 'fuel' : null);
  const glyph = placed ? '◎' : row ? (CATEGORIES.find((c) => c.id === poiCategory(row.primaryType, row.primaryType))?.glyph ?? '📍') : poiGlyph(poi.cls, poi.subclass);
  const [details, setDetails] = useState(!isPhone);
  // a different place opens on its own page again (desktop), never mid-ride-strip
  useEffect(() => { setDetails(!isPhone); setConfirm(false); }, [poi?.lat, poi?.lng, row?.id, isPhone]); // eslint-disable-line react-hooks/exhaustive-deps
  const place = match
    ? { ...match, name: match.name, lat: match.lat, lng: match.lng, detail: match.detail, placeId: match.id, id: match.id, source: 'google', verified: 'google' }
    : placed
    ? { name: poi.name, lat: poi.lat, lng: poi.lng, detail: poi.detail ?? '', source: 'rider', placed }
    : { name: poi.name, lat: poi.lat, lng: poi.lng, detail: '', source: 'osm', ...(natural ? { placed: 'rider', kind: 'photo' } : {}) };
  const elev = poi.elevFt ? (u.metric ? `${Math.round(poi.elevFt / 3.28084)} m` : `${poi.elevFt.toLocaleString()} ft`) : '';
  const kicker = placed
    ? (poi.detail && poi.detail !== poi.name ? poi.detail : coordLabel(poi))
    : [match && cat === 'food' ? cuisineLabel(match.primaryType, match.types) : '', elev, poi.subclass || poi.cls].filter(Boolean).join(' · ').replace(/_/g, ' ');
  const dist = fix ? `${u.miNum(haversineMiles(fix, poi))} ${u.miUnit} ${t('from you')}` : '';
  const hours = Array.isArray(match?.hours) && match.hours.length ? match.hours : null;
  // The place's full page. It carries everything the card said (the lookup note,
  // a placed tag, the distance) because on a desktop it is the first and only
  // thing shown — the card is not rendered behind it — and there its ✕ closes
  // the place. On a phone it opens from the card's Details as the bottom sheet
  // and its ✕ goes back to the card.
  const sheet = details ? (
    <PlaceSheet
      inline="desktop"
      place={place} glyph={glyph} kicker={kicker}
      note={placed ? t('A spot you placed on the map — not a listed business. It rides as a deliberate pin.')
        : natural ? t('A place on the map, not a listed business — it will be added as a placed pin.')
        : match === undefined ? t('Checking the listing…')
        : match === null ? t('No listing found here — it will be added as an unverified stop.')
        : null}
      facts={placed || dist ? <>{placed && <span className="tag placed">◎ {t('placed')}</span>}{dist && <span className="nb-note">{dist}</span>}</> : null}
      onClose={isPhone ? () => setDetails(false) : onClose}
      actions={(<><button className="btn gold" disabled={match === undefined} onClick={() => { setDetails(false); setConfirm(true); }}>{t('Ride here')}</button><button className="btn" disabled={match === undefined} onClick={() => { setDetails(false); onAdd(place); }}>{t('Add to a trip')}</button></>)}
    />
  ) : null;
  if (sheet && !isPhone) return <div className={`hm-place${placed ? ' placed' : ''}`} role="dialog" aria-label={place.name}>{sheet}</div>;
  return (
    <div className={`hm-place${placed ? ' placed' : ''}`} role="dialog" aria-label={place.name}>
      <div className="hm-place-head">
        <span className="poi-glyph" aria-hidden="true">{glyph}</span>
        <div className="poi-title"><b>{place.name}</b><small><span className="hm-kicker">{kicker}</span>{kicker && dist ? ' · ' : ''}<span className="hm-dist">{dist}</span></small></div>
        <button className="mini-edit" onClick={onClose} aria-label={t('Close')}>✕</button>
      </div>
      <div className="poi-facts">
        {placed && <span className="tag placed" title={t('A spot placed on the map on purpose — not a listed business.')}>◎ {t('placed')}</span>}
        {placed && <span className="nb-note">{t('A spot you placed on the map — not a listed business. It rides as a deliberate pin.')}</span>}
        {natural && <span className="nb-note">{t('A place on the map, not a listed business — it will be added as a placed pin.')}</span>}
        {!placed && !natural && match === undefined && <span className="nb-note">{t('Checking the listing…')}</span>}
        {!placed && !natural && match === null && <span className="nb-note">{t('No listing found here — it will be added as an unverified stop.')}</span>}
        {match && (
          <>
            {Number.isFinite(match.rating) && <span className="nb-rate">★ {match.rating.toFixed(1)}{match.userRatingCount ? <small> ({match.userRatingCount})</small> : null}</span>}
            {priceGlyph(match.priceLevel) && <span className="nb-price">{priceGlyph(match.priceLevel)}</span>}
            {match.openNow != null && <span className={`nb-open ${match.openNow ? 'ok' : 'bad'}`}>{match.openNow ? t('Open now') : t('Closed now')}</span>}
            {hours && <span className="ps-today">{t('Today')} {hoursOnly(hours[todayIndex()])}</span>}
            <span className="nb-ver">✓ {t('Verified')}</span>
          </>
        )}
      </div>
      {confirm ? (
        <section className="quick-ride hm-ride-confirm">
          {(() => {
            const here = fix ? { name: t('Current location'), lat: fix.lat, lng: fix.lng } : null;
            const a = from ?? here; // the From place (or nothing, if no fix and none chosen)
            const start = swapped ? place : a;
            const end = swapped ? a : place;
            const go = () => { if (!start || !end) return; onRide(end, { style, avoidTolls }, start); };
            return (
              <>
                <div className="hm-od" role="group" aria-label={t('Route')}>
                  <div className="hm-od-row">
                    <span className="hm-od-k">{t('From')}</span>
                    <span className="hm-od-v">{start?.name ?? t('Pick a start')}</span>
                    {!swapped && <button className="mini-edit" onClick={() => setFromEdit((v) => !v)} aria-label={t('Change start')}>✎</button>}
                  </div>
                  <button className="btn hm-od-swap" onClick={() => setSwapped((v) => !v)} aria-label={t('Swap')} title={t('Swap')}>⇅</button>
                  <div className="hm-od-row">
                    <span className="hm-od-k">{t('To')}</span>
                    <span className="hm-od-v">{end?.name ?? t('Pick a destination')}</span>
                    {swapped && <button className="mini-edit" onClick={() => setFromEdit((v) => !v)} aria-label={t('Change destination')}>✎</button>}
                  </div>
                  {fromEdit && (
                    <div className="hm-od-search">
                      <input className="hm-input" autoFocus value={fromQ} onChange={(e) => setFromQ(e.target.value)} placeholder={t('Search a place')} aria-label={t('Search a place')} />
                      <div className="hm-results">
                        {here && from && <button onClick={() => { setFrom(null); setFromEdit(false); setFromQ(''); }}>◎ {t('Current location')}</button>}
                        {fromRows.map((r) => <button key={r.id} onClick={() => { setFrom({ name: r.name, lat: r.lat, lng: r.lng, placeId: r.id, verified: 'google' }); setFromEdit(false); setFromQ(''); }}>{r.name}<small> {r.detail}</small></button>)}
                      </div>
                    </div>
                  )}
                </div>
                <div className="qk-prefs">
            <div className="qk-roads" role="radiogroup" aria-label={t('Roads')}>
              {[['quick', t('Quick')], ['touring', t('Touring')], ['backroads', t('Back roads')]].map(([id, label]) => (
                <button key={id} role="radio" aria-checked={style === id} className={style === id ? 'active' : ''} onClick={() => setStyle(id)}>{label}</button>
              ))}
            </div>
            <label className="qk-tolls"><input type="checkbox" checked={avoidTolls} onChange={(e) => setAvoidTolls(e.target.checked)} /> {t('Avoid tolls')}</label>
          </div>
                <div className="hm-place-actions">
                  <button className="btn gold" disabled={!start || !end} onClick={go}>▶ {t('Go')}</button>
                  <button className="btn" onClick={() => { setConfirm(false); if (!isPhone) setDetails(true); }}>{t('Back')}</button>
                </div>
              </>
            );
          })()}
        </section>
      ) : (
        <div className="hm-place-actions">
          <button className="btn gold" disabled={match === undefined} onClick={() => setConfirm(true)}>{t('Ride here')}</button>
          <button className="btn" disabled={match === undefined} onClick={() => onAdd(place)}>{t('Add to a trip')}</button>
          {match && <button className="btn" onClick={() => setDetails(true)}>{t('Details')}</button>}
        </div>
      )}
      {/* a phone: Details opens the page as the bottom sheet over the card */}
      {sheet}
    </div>
  );
}

// The pill, opened: a place name searches the map near you; a sentence is a
// plan and the builder opens with it — the same words, both doors.
// On a phone it is a full screen of its own; on a desktop (`variant="dropdown"`)
// the pill in the nav bar IS the field and the answers drop down under it —
// the drawer is left alone (owner, Sep 14 2026: "just have it be handled from
// drop down screen from search").
function HomeSearch({ near, onClose, onPlan, onPick, variant = 'screen' }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const boxRef = useRef(null);
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
  // the dropdown closes on a press anywhere outside it, like any other menu
  useEffect(() => {
    if (variant !== 'dropdown') return undefined;
    const onDown = (e) => { if (!boxRef.current?.contains(e.target)) onClose(); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [variant]); // eslint-disable-line react-hooks/exhaustive-deps
  const plan = q.trim().length > 0 && readsAsPlan(q);
  const input = (
    <input ref={inputRef} className="hm-input" value={q} placeholder={t('Search a place, or describe a ride')} onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && plan) onPlan(q.trim()); }} />
  );
  if (variant === 'dropdown') {
    return (
      <div ref={boxRef} className="hm-search dropdown">
        <label className="hm-pill hm-pill-input">
          <SearchGlyph />
          {input}
          <button type="button" className="hm-pill-x" onClick={onClose} aria-label={t('Close')}>✕</button>
        </label>
        <div className="hm-dropdown" aria-label={t('Search a place, or describe a ride')}>
          <HomeSearchAnswers q={q} plan={plan} rows={rows} busy={busy} recent={recent} near={near} onPlan={onPlan} onPick={onPick} />
        </div>
      </div>
    );
  }
  return (
    <div className="hm-search" role="dialog" aria-label={t('Search a place, or describe a ride')}>
      <div className="hm-pillrow">
        <button className="hm-round" onClick={onClose} aria-label={t('Back')}>‹</button>
        {input}
      </div>
      <HomeSearchAnswers q={q} plan={plan} rows={rows} busy={busy} recent={recent} near={near} onPlan={onPlan} onPick={onPick} />
    </div>
  );
}

// What the search offers under the field — the AI door, the places, recents —
// the same list in the phone's full screen and the desktop's dropdown.
function HomeSearchAnswers({ q, plan, rows, busy, recent, near, onPlan, onPick }) {
  const t = useT();
  const u = useUnits();
  return (
    <>
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
    </>
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

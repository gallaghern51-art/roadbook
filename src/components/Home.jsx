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
import RouteSheet from './RouteSheet.jsx';
import { useIsMobile } from '../hooks/useMediaQuery.js';
import HomeMap from './HomeMap.jsx';
import { BASEMAPS } from '../engine/basemaps.js';
import PlaceSheet from './PlaceSheet.jsx';
import { usePoiMatch } from './PoiCard.jsx';
import { Sheet, InputSheet } from './Sheets.jsx';
import SavePlaceSheet from './SavePlaceSheet.jsx';
import SharePlacesSheet from './SharePlacesSheet.jsx';
import { findSaved, placesInList } from '../engine/profile.js';
import { shareTokenIn } from '../engine/placeShare.js';

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
  // the route sheet holds From, the stops, To, the options and Go — it peeks
  // tall because the From/To rows ARE the surface, and a peek that hid them
  // behind a scroll was the first thing the built screen got wrong
  // 0.58 is measured, not guessed: From / stops / To, the toll rule, the
  // options and Go come to ~470px at 375×812, and anything taller buries the
  // very map the options are drawn on.
  route: { min: 0.06, peek: 0.58, up: 0.94 },
  // a saved list, or places someone shared: a few rows, and the map above
  // them has to show the places — the picker's 72% left ~110px of map on a
  // phone, too little to frame anything in
  list: { min: 0.06, peek: 0.5, up: 0.9 },
};
const detentsFor = (surface) => SURFACE_PX[surface] ?? SHEET_PX;
const DETENTS = ['min', 'peek', 'up'];
const nearestDetent = (frac, px = SHEET_PX) => DETENTS.reduce((best, k) => (Math.abs(px[k] - frac) < Math.abs(px[best] - frac) ? k : best), 'peek');

// `ride` (the composition in progress) is App's state, not Home's: it has to
// survive Ride Mode, which unmounts this screen entirely. Cancelling
// navigation then lands back HERE with the ride intact.
export default function Home({ onOpenTrip, onNewTrip, onImport, onDeleteTrip, onSettings, onHelp, onUseTemplate, onShareTemplate, onDeleteTemplate, onQuickRide, onRideAgain, onPromoteQuick, onDeleteQuick, onAddToTrip, quickDefaults, ride = null, onRideChange, profile = null, shared = null, onSharedClose, onOpenShare }) {
  const setRide = onRideChange;
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
  const [standalone] = useState(isStandalone);
  const [addTo, setAddTo] = useState(null);    // a place → which trip?
  // Saved places (owner, Sep 22 2026: "save the location as favorite or a list
  // and then share locations to someone with link"). They live on the rider's
  // PROFILE — the account's, not the device's — so the map, the sheet, the
  // search and the add-a-stop picker all read the one list.
  const prof = profile?.profile ?? { places: [], lists: [] };
  const savedRows = prof.places ?? [];
  const [saving, setSaving] = useState(null);     // a place → the Save sheet
  const [sharing, setSharing] = useState(null);   // { name, kind, places } → the Share sheet
  const [listView, setListView] = useState(null); // 'favorites' | a list id → that list in the sheet
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const flash = (msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 2600); };
  // the route sheet is showing the add-a-stop picker — declared here because
  // `surface` below reads it, and `surface` sizes the sheet
  const [ridePicking, setRidePicking] = useState(false);
  // a list of saved places — or places someone shared — is its own surface:
  // shorter than the picker, so the places it lists are visible above it
  const surface = ride ? (ridePicking ? 'pick' : 'route') : place ? 'place' : chip ? 'pick' : (listView || shared) ? 'list' : null;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const sheetPx = Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * detentsFor(surface)[sheet]);
  // What covers the map, for framing: the SHEET along the bottom on a phone;
  // on a desktop the drawer down the left (440px + its 16px inset) and nothing
  // along the bottom. Framing used the phone's detent on a desktop too, which
  // padded the bottom 72% of the window and squeezed a list into the top strip.
  const drawerShown = !isPhone && !!(drawer || place || chip || ride || listView || shared);
  // the top clears the chrome AND a pin's own label (a phone's layers pill
  // hangs lower, under the chips)
  const mapPad = isPhone ? { top: 240, bottom: sheetPx, left: 0 } : { top: 190, bottom: 0, left: drawerShown ? 472 : 0 };
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
  // The top chrome's real bottom edge, written as `--hm-top` the same way, so
  // everything that hangs under it (the layers pill, Search this area, the
  // desktop drawer) sits under what is ACTUALLY there. They were pinned to one
  // row's height, and a desktop window narrow enough to wrap the chips onto a
  // second row put the Satellite pill across them (owner, Sep 20 2026: "the
  // satellite button is crossing into the header").
  const topRef = useRef(null);
  useLayoutEffect(() => {
    const root = rootRef.current, el = topRef.current;
    if (!root || !el) return;
    const write = () => root.style.setProperty('--hm-top', `${Math.round(el.getBoundingClientRect().bottom - root.getBoundingClientRect().top)}px`);
    write();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(write);
    ro.observe(el);
    return () => ro.disconnect();
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
    if (surface === 'route') return { label: t('Show the route'), aria: t('Show the route') };
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
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: { top: 150, bottom: mapPad.bottom + 24, left: 32 + mapPad.left, right: 72 }, duration: 700, maxZoom: 11 });
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
  // A saved (or shared) place opens as what it is: a listing reopens as that
  // listing — the card and its Details look it up by id — and a pin the rider
  // dropped reopens as a placed spot, never looked up.
  const openSaved = (p) => {
    const name = p.label ?? p.name;
    setChip(null); setPins([]);
    if (p.placeId) showPlace({ name, lat: p.lat, lng: p.lng, cls: '', subclass: '' }, { id: p.placeId, name, lat: p.lat, lng: p.lng, detail: p.address ?? '', source: 'google' });
    else showPlace({ name, lat: p.lat, lng: p.lng, cls: '', subclass: '', placed: 'rider', detail: p.address ?? '' });
  };
  // A Roadbook link pasted into the search (the Home Screen app never receives
  // a tapped link on an iPhone — it opens in Safari — so the rider copies it
  // and pastes it here): open the share it names, as if the link had been tapped.
  const openShareToken = (token) => { setSearching(false); onOpenShare?.(token); };
  const openList = (id) => { setPlace(null); setChip(null); setPins([]); setListView(id); raiseFor(); setFitAt(Date.now()); };
  const closeList = () => { setListView(null); lowerAfter(); };
  const listName = (id) => (id === 'favorites' ? t('Favorites') : prof.lists.find((l) => l.id === id)?.name ?? '');
  // a link someone sent: the places come up on the map, framed, with the list in the sheet
  useEffect(() => {
    if (!shared) return;
    setPlace(null); setChip(null); setPins([]); setListView(null); setDrawer(false);
    raiseFor();
    setFitAt(Date.now());
  }, [shared]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveShared = () => {
    if (!shared || !profile) return;
    if (shared.places.length === 1) { const p = shared.places[0]; setSaving({ name: p.name, lat: p.lat, lng: p.lng, detail: p.address ?? '', placeId: p.placeId, placed: p.placed, note: p.note }); return; }
    const id = profile.createList(shared.name);
    shared.places.forEach((p) => profile.addToList({ name: p.name, lat: p.lat, lng: p.lng, address: p.address ?? '', placeId: p.placeId, placed: p.placed }, id, { label: p.name, note: p.note ?? '' }));
    flash(`${t('Saved to')} ${shared.name}`);
    onSharedClose?.();
    openList(id);
  };
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
  // the ride being composed: it outlives Ride Mode, so cancelling navigation
  // hands back the sheet with the ride still on it rather than dumping the
  // rider into the trip workspace
  const [routeOpts, setRouteOpts] = useState([]);
  const [routeSel, setRouteSel] = useState(null);
  const [routeFitAt, setRouteFitAt] = useState(0);

  const sheetBeforeDrop = useRef(null);
  const pickingStopRef = useRef(false); // "Choose on map" is waiting for a pin
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
    // "Choose on map" in the add-a-stop picker armed this: the needle the
    // rider placed is a STOP on the route they are composing, not a card to
    // read. Everything else about the drop is unchanged.
    if (pickingStopRef.current) {
      pickingStopRef.current = false;
      const stop = { name: dropped.name ?? coordLabel(dropped), lat: dropped.lat, lng: dropped.lng, detail: dropped.detail ?? '', placed: 'rider' };
      setRide?.((r) => (r ? { ...r, stops: [...(r.stops ?? []), stop] } : r));
      setDropped(null);
      if (sheetBeforeDrop.current != null) { setSheet(sheetBeforeDrop.current); sheetBeforeDrop.current = null; }
      return;
    }
    showPlace({ name: dropped.name ?? coordLabel(dropped), lat: dropped.lat, lng: dropped.lng, cls: '', subclass: '', placed: 'rider', detail: dropped.detail ?? '' });
  };
  const cancelDrop = () => {
    clearTimeout(geoTimer.current); setDropped(null); setPlace((p) => (p?.poi?.placed ? null : p));
    if (sheetBeforeDrop.current != null) { setSheet(sheetBeforeDrop.current); sheetBeforeDrop.current = null; }
  };
  const dropReadout = dropped ? `${dropped.name ?? coordLabel(dropped, 5)}${dropped.name ? ` · ${coordLabel(dropped, 5)}` : ''}` : '';

  // "Ride here" no longer goes straight to Go. It opens the ROUTE SHEET — the
  // ride laid out as From / stops / To with every road measured and on the map
  // — because a rider choosing between Quick and Back roads was choosing
  // blind, and because there was nowhere to add a stop before setting off
  // (owner, Sep 19 2026). Go, from that sheet, is what starts the ride.
  const rideTo = async (dest) => {
    // The sheet opens FIRST and waits for the fix. Before this, a rider with
    // location off or denied tapped "Ride here" and nothing happened at all —
    // no sheet, no note, no error. The sheet answers that honestly: From reads
    // "Pick a start", Go is disabled until both ends exist, and the fix drops
    // in behind it if one arrives.
    const known = ride?.start ?? fix;
    const asStart = (p) => (p
      ? { name: p.name ?? t('Current location'), lat: p.lat, lng: p.lng, ...(p.placeId ? { placeId: p.placeId } : {}) }
      : null);
    setRide({
      start: asStart(known),
      stops: [],
      end: dest,
      avoidTolls: !!quickDefaults?.routePrefs?.avoidTolls,
      optionId: null,
    });
    setPlace(null);
    setSheet((cur) => { if (sheetBeforeRaise.current == null) sheetBeforeRaise.current = cur; return 'peek'; });
    requestAnimationFrame(() => { const b = rootRef.current?.querySelector('.hm-body'); if (b) b.scrollTop = 0; });
    // the sheet is already up; the fix, if one can be had, drops in behind it
    if (!known) {
      const got = await locate().catch(() => null);
      if (got) setRide((r) => (r && !r.start ? { ...r, start: asStart(got) } : r));
    }
  };
  const closeRide = () => { setRide(null); setRidePicking(false); setRouteOpts([]); setRouteSel(null); lowerAfter(); };

  // What the map shows: the picker's rows while a chip is open; otherwise the
  // rider's saved places (just one list's while a list is open, or the places
  // someone shared while their link is open), with the open card's place hot —
  // or its own pin when it is not one of them.
  const baseRows = shared
    ? shared.places.map((p, i) => ({ ...p, key: `shared:${i}`, label: p.name }))
    : (listView ? placesInList(prof, listView) : savedRows).map((p) => ({ ...p, key: `saved:${p.id}` }));
  const at = (p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
  const hotAt = place ? at(place.poi) : null;
  const savedGlyph = (p) => (shared ? '◆' : p.role === 'home' ? '⌂' : p.role === 'work' ? '▣' : p.role === 'favorite' ? '★' : '▤');
  const basePins = baseRows.map((p) => ({ id: p.key, lat: Number(p.lat), lng: Number(p.lng), name: p.label ?? p.name, glyph: savedGlyph(p), cat: shared ? 'shared' : 'saved', hot: hotAt === at(p) }));
  const cardPin = place && !place.poi.placed && !basePins.some((b) => b.hot)
    ? [{ id: 'place', lat: place.poi.lat, lng: place.poi.lng, name: place.poi.name, glyph: place.row ? (CATEGORIES.find((c) => c.id === poiCategory(place.row.primaryType, place.row.primaryType))?.glyph ?? '📍') : poiGlyph(place.poi.cls, place.poi.subclass), cat: place.row ? poiCategory(place.row.primaryType, place.row.primaryType) : poiCategory(place.poi.cls, place.poi.subclass), hot: true, halo: !place.row }]
    : [];
  const mapPins = pins.length ? pins : [...basePins, ...(dropped ? [] : cardPin)];

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
        pins={mapPins}
        fitAt={fitAt}
        sheetPx={mapPad.bottom}
        padLeft={mapPad.left}
        padTop={mapPad.top}
        drop={dropped}
        routeOpts={routeOpts}
        routeSel={routeSel}
        onRouteSel={(id) => { setRouteSel(id); setRide((r) => (r ? { ...r, optionId: id } : r)); }}
        routeFitAt={routeFitAt}
        onPinTap={(id) => {
          if (id.startsWith('saved:')) { const p = savedRows.find((x) => `saved:${x.id}` === id); if (p) openSaved(p); return; }
          if (id.startsWith('shared:')) { const p = shared?.places[Number(id.slice(7))]; if (p) openSaved(p); return; }
          setTapped({ id, at: Date.now() });
        }}
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

      <div ref={topRef} className={`hm-top${searching && !isPhone ? ' searching' : ''}`}>
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
              saved={savedRows}
              onSaved={(p) => { setSearching(false); openSaved(p); }}
              onShareToken={openShareToken}
            />
          ) : (
            <button className="hm-pill" onClick={() => setSearching(true)} aria-label={t('Search a place, or describe a ride')}>
              <SearchGlyph />
              <span>{t('Where do you want to ride?')}</span>
            </button>
          )}
          <div className="hm-actions">
            <button className={`hm-tripsbtn${drawer ? ' active' : ''}`} onClick={() => { setDrawer(!drawer); setPlace(null); setChip(null); }} aria-pressed={drawer}>{t('Your trips')} <span className="cnt">{cards.length}</span></button>
            <button className="hm-round" onClick={onSettings} aria-label={t('Settings')}><SettingsIcon /></button>
          </div>
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
      {/* the right-edge column: frame my trips (only while none is in view) · North up (only while turned) · locate.
          A phone floats it just above the sheet; a desktop stacks it at the middle of the right edge with Near me
          on top (owner, Sep 14 2026: "put the locator buttons on map view and the near me on mid right side
          stacked, near me on top") */}
      <div className={`hm-fabs${isPhone ? '' : ' desk'}`}>
        {!isPhone && !dropped && fix && <button type="button" className="hm-near mono" onClick={goToMe} title={t('Near me')}>{fix.name === 'Current location' ? t('Near you') : `${t('Near')} ${fix.name}`}</button>}
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
        : fix && isPhone && <button type="button" className="hm-near mono" onClick={goToMe} title={t('Near me')}>{fix.name === 'Current location' ? t('Near you') : `${t('Near')} ${fix.name}`}</button>}

      {/* the phone's search is a screen of its own; the desktop's hangs under the pill (above) */}
      {searching && isPhone && (
        <HomeSearch
          near={near}
          onClose={() => setSearching(false)}
          onPlan={(q) => { setSearching(false); onNewTrip({ tab: 'ai', prompt: q }); }}
          onPick={(row) => { setSearching(false); setChip(null); showPlace(rowToPoi(row), row); }}
          saved={savedRows}
          onSaved={(p) => { setSearching(false); openSaved(p); }}
          onShareToken={openShareToken}
        />
      )}

      <div ref={sheetRef} className={`hm-sheet${ride ? ' route' : ''}${place && !ride ? ' place' : ''}${(chip && !ride) || ridePicking ? ' pick' : ''}${surface === 'list' ? ' list' : ''}${drawer || place || chip || ride || listView || shared ? ' open' : ''}`} data-state={sheet}>
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
          {ride ? (
            <RouteSheet
              ride={ride}
              pace={quickDefaults?.pace ?? 1}
              prefer={quickDefaults?.routePrefs?.style ?? null}
              onChange={setRide}
              onOptions={(list, sel) => {
                setRouteOpts(list);
                setRouteSel(sel);
                if (list.length) setRouteFitAt(Date.now());
              }}
              onGo={(r, option) => onQuickRide({
                start: r.start, stops: r.stops ?? [], dest: r.end,
                routePrefs: option?.prefs ?? { style: 'touring', avoidTolls: !!r.avoidTolls },
              })}
              onClose={closeRide}
              saved={savedRows}
              onAdding={setRidePicking}
              onChooseOnMap={() => {
                pickingStopRef.current = true;
                setSheet((cur) => { if (sheetBeforeDrop.current == null) sheetBeforeDrop.current = cur; return 'min'; });
              }}
            />
          ) : place ? (
            <HomePlaceCard
              poi={place.poi} row={place.row} fix={fix} defaults={quickDefaults}
              onRide={rideTo}
              onAdd={(p) => setAddTo(p)}
              savedFor={profile ? (p) => findSaved(prof, p) : null}
              listNames={(row) => [row.role === 'favorite' ? t('Favorites') : row.role === 'home' ? t('Home') : row.role === 'work' ? t('Work') : null, ...(row.lists ?? []).map(listName)].filter(Boolean).join(', ')}
              onSave={profile ? (p) => setSaving(p) : null}
              onShare={(p, row) => setSharing({ name: row?.label ?? p.name, kind: 'place', places: [{ ...p, label: row?.label ?? p.name, note: row?.note ?? '', address: p.detail ?? row?.address ?? '' }] })}
              onClose={() => { setPlace(null); if (place.poi.placed) cancelDrop(); else if (!listView && !shared) lowerAfter(); }}
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
          ) : shared ? (
            <SavedListView
              kicker={t('Shared with you')}
              tone="shared"
              title={shared.name}
              rows={shared.places.map((p) => ({ ...p, label: p.name, saved: !!findSaved(prof, p) }))}
              fix={fix}
              onOpen={openSaved}
              primary={profile && shared.places.length ? { label: shared.places.length === 1 ? t('Save it') : t('Save them to my places'), onClick: saveShared } : null}
              onBack={() => { onSharedClose?.(); lowerAfter(); }}
              backLabel={t('Close')}
              empty={shared.error ?? ''}
              notice={isPhone && !standalone && shared.token && shared.places.length > 0 ? <InAppHint token={shared.token} /> : null}
            />
          ) : listView ? (
            <SavedListView
              kicker={t('Saved')}
              title={listName(listView)}
              rows={placesInList(prof, listView)}
              fix={fix}
              onOpen={openSaved}
              onBack={closeList}
              onShare={(rows) => setSharing({ name: listName(listView), kind: 'list', places: rows })}
              onRename={listView !== 'favorites' ? (name) => profile?.renameList(listView, name) : null}
              onDelete={listView !== 'favorites' ? () => { profile?.deleteList(listView); closeList(); } : null}
              empty={t('Nothing in this list yet. Open a place — tap it on the map, or press and hold to drop a pin — and Save it here.')}
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
              {profile && (
                <section className="section hm-saved">
                  <h3>{t('Saved')} {savedRows.length > 0 && <span className="cnt">{savedRows.length}</span>}</h3>
                  {savedRows.length === 0 ? (
                    <p className="nb-note">{t('Save places you ride to — tap one on the map, or press and hold to drop a pin, then Save. Share a place or a whole list as a link.')}</p>
                  ) : (
                    <div className="hm-saved-row">
                      {savedRows.filter((p) => p.role === 'home' || p.role === 'work').map((p) => (
                        <button key={p.id} className="hm-list-chip" onClick={() => openSaved(p)}>
                          <i aria-hidden="true">{p.role === 'home' ? '⌂' : '▣'}</i><b>{p.role === 'home' ? t('Home') : t('Work')}</b><small>{p.label}</small>
                        </button>
                      ))}
                      <button className="hm-list-chip" onClick={() => openList('favorites')}>
                        <i aria-hidden="true">★</i><b>{t('Favorites')}</b><small>{placesInList(prof, 'favorites').length}</small>
                      </button>
                      {prof.lists.map((l) => (
                        <button key={l.id} className="hm-list-chip" onClick={() => openList(l.id)}>
                          <i aria-hidden="true">▤</i><b>{l.name}</b><small>{placesInList(prof, l.id).length}</small>
                        </button>
                      ))}
                    </div>
                  )}
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

      {saving && profile && (
        <SavePlaceSheet
          place={saving}
          saved={findSaved(prof, saving)}
          lists={prof.lists}
          onCreateList={profile.createList}
          onSave={(opts) => {
            profile.saveTo(saving, opts);
            const none = !opts.role && !opts.favorite && !(opts.lists ?? []).length;
            flash(none ? t('Removed from saved') : `${t('Saved to')} ${[opts.role === 'home' ? t('Home') : opts.role === 'work' ? t('Work') : opts.favorite ? t('Favorites') : null, ...(opts.lists ?? []).map(listName)].filter(Boolean).join(', ')}`);
          }}
          onClose={() => setSaving(null)}
        />
      )}
      {sharing && <SharePlacesSheet payload={sharing} onClose={() => setSharing(null)} />}
      {toast && <div className="hm-toast" role="status" aria-live="polite">{toast}</div>}

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
function HomePlaceCard({ poi, row, fix, onRide, onAdd, onClose, defaults, savedFor = null, listNames = null, onSave = null, onShare = null }) {
  const t = useT();
  const u = useUnits();
  // On a desktop the drawer opens straight onto the place's full page: there is
  // room, and a card whose main job was leading to Details was one click too
  // many (owner, Sep 14 2026: "why not just show full details for it to begin
  // with?"). A phone keeps the compact card at the sheet's peek.
  const isPhone = useIsMobile();
  const placed = poi.placed ?? null; // a dropped pin: nothing to look up, nothing to verify
  const looked = usePoiMatch(row || placed ? null : poi);
  // "Ride here" hands the place to the ROUTE SHEET rather than opening a Roads
  // radio here. The road character is no longer a setting chosen blind: the
  // roads themselves are measured, drawn and labelled there, and From / stops
  // / To live on the same surface (owner, Sep 19 2026).
  const match = placed ? null : (row ?? looked);
  const natural = !row && !placed && poiIsNatural(poi.cls, poi.subclass); // a peak, a pass, a forest: a placed pin, never a lookup
  const cat = poiCategory(poi.cls, poi.subclass) ?? (match?.primaryType?.includes('gas') ? 'fuel' : null);
  const glyph = placed ? '◎' : row ? (CATEGORIES.find((c) => c.id === poiCategory(row.primaryType, row.primaryType))?.glyph ?? '📍') : poiGlyph(poi.cls, poi.subclass);
  const [details, setDetails] = useState(!isPhone);
  // a different place opens on its own page again (desktop)
  useEffect(() => { setDetails(!isPhone); }, [poi?.lat, poi?.lng, row?.id, isPhone]); // eslint-disable-line react-hooks/exhaustive-deps
  const place = match
    ? { ...match, name: match.name, lat: match.lat, lng: match.lng, detail: match.detail, placeId: match.id, id: match.id, source: 'google', verified: 'google' }
    : placed
    ? { name: poi.name, lat: poi.lat, lng: poi.lng, detail: poi.detail ?? '', source: 'rider', placed }
    : { name: poi.name, lat: poi.lat, lng: poi.lng, detail: '', source: 'osm', ...(natural ? { placed: 'rider', kind: 'photo' } : {}) };
  // Is this place one the rider saved? Then the card says where it is kept and
  // shows their note; Save becomes Saved and opens the same sheet to edit it.
  const savedRow = savedFor ? savedFor(place) : null;
  const savedTag = savedRow ? (
    <>
      <span className="tag saved">★ {t('Saved')}{listNames?.(savedRow) ? ` · ${listNames(savedRow)}` : ''}</span>
      {savedRow.note && <span className="nb-note hm-saved-note">{savedRow.note}</span>}
    </>
  ) : null;
  const keepButtons = (
    <>
      {onSave && <button className={`btn hm-keep${savedRow ? ' on' : ''}`} disabled={match === undefined} onClick={() => onSave(place)} aria-pressed={!!savedRow}>{savedRow ? `★ ${t('Saved')}` : `☆ ${t('Save')}`}</button>}
      {onShare && <button className="btn hm-keep" disabled={match === undefined} onClick={() => onShare(place, savedRow)}>{t('Share')}</button>}
    </>
  );
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
      facts={placed || dist || savedTag ? <>{savedTag}{placed && <span className="tag placed">◎ {t('placed')}</span>}{dist && <span className="nb-note">{dist}</span>}</> : null}
      onClose={isPhone ? () => setDetails(false) : onClose}
      actions={(<><button className="btn gold" disabled={match === undefined} onClick={() => { setDetails(false); onRide(place); }}>{t('Ride here')}</button><button className="btn" disabled={match === undefined} onClick={() => { setDetails(false); onAdd(place); }}>{t('Add to a trip')}</button>{keepButtons}</>)}
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
        {savedTag}
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
      <div className="hm-place-actions">
        <button className="btn gold" disabled={match === undefined} onClick={() => onRide(place)}>{t('Ride here')}</button>
        <button className="btn" disabled={match === undefined} onClick={() => onAdd(place)}>{t('Add to a trip')}</button>
        {match && <button className="btn" onClick={() => setDetails(true)}>{t('Details')}</button>}
      </div>
      {(onSave || onShare) && <div className="hm-place-more">{keepButtons}</div>}
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
function HomeSearch({ near, onClose, onPlan, onPick, variant = 'screen', saved = [], onSaved = null, onShareToken = null }) {
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
  // a Roadbook share link typed or pasted into the field opens its places —
  // the link alone or the whole message it came in
  const onText = (value) => {
    const token = onShareToken ? shareTokenIn(value) : null;
    if (token) { onShareToken(token); return; }
    setQ(value);
  };
  // "Open a shared link" reads the clipboard from its own tap (iOS asks with
  // its Paste callout). Nothing there that is a link → say how to get one.
  const [pasteNote, setPasteNote] = useState('');
  const canPaste = !!onShareToken && typeof navigator !== 'undefined' && !!navigator.clipboard?.readText;
  const pasteLink = async () => {
    setPasteNote('');
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* refused */ }
    const token = shareTokenIn(text);
    if (token) onShareToken(token);
    else setPasteNote(t('No Roadbook link on the clipboard — copy the link first, then tap here.'));
  };
  const paste = canPaste ? { onPaste: pasteLink, note: pasteNote } : null;
  const input = (
    <input ref={inputRef} className="hm-input" value={q} placeholder={t('Search a place, or describe a ride')} onChange={(e) => onText(e.target.value)}
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
          <HomeSearchAnswers q={q} plan={plan} rows={rows} busy={busy} recent={recent} near={near} onPlan={onPlan} onPick={onPick} saved={saved} onSaved={onSaved} paste={paste} />
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
      <HomeSearchAnswers q={q} plan={plan} rows={rows} busy={busy} recent={recent} near={near} onPlan={onPlan} onPick={onPick} saved={saved} onSaved={onSaved} paste={paste} />
    </div>
  );
}

// What the search offers under the field — the AI door, the places, recents —
// the same list in the phone's full screen and the desktop's dropdown.
function HomeSearchAnswers({ q, plan, rows, busy, recent, near, onPlan, onPick, saved = [], onSaved = null, paste = null }) {
  const t = useT();
  const u = useUnits();
  // The rider's own places answer first: Home and Work, then the most recently
  // saved, when the field is empty; any whose name or address matches while
  // they type — before a single place is looked up.
  const text = q.trim().toLowerCase();
  const roleRank = (p) => (p.role === 'home' ? 0 : p.role === 'work' ? 1 : 2);
  const mine = (text
    ? saved.filter((p) => `${p.label} ${p.address ?? ''}`.toLowerCase().includes(text))
    : [...saved].sort((a, b) => roleRank(a) - roleRank(b) || String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')))
  ).slice(0, text ? 4 : 6);
  const savedList = onSaved && mine.length > 0 && !plan ? (
    <>
      <div className="mono hm-label">{t('Saved')}</div>
      <ul className="hm-results hm-saved-results">
        {mine.map((p) => (
          <li key={p.id}><button onClick={() => onSaved(p)}>
            <span className="hm-res-pin" aria-hidden="true">{p.role === 'home' ? '⌂' : p.role === 'work' ? '▣' : p.role === 'favorite' ? '★' : '▤'}</span>
            <span className="hm-res-main"><b>{p.label}</b><small>{[p.address, Number.isFinite(p.lat) ? `${u.miNum(haversineMiles(near, p))} ${u.miUnit}` : ''].filter(Boolean).join(' · ')}</small></span>
          </button></li>
        ))}
      </ul>
    </>
  ) : null;
  return (
    <>
      {q.trim().length > 0 && (
        <button className={`hm-ai${plan ? ' lead' : ''}`} onClick={() => onPlan(q.trim())}>
          <span className="hm-ai-glyph" aria-hidden="true">✦</span>
          <span><b>{plan ? t('Plan this ride with AI') : `${t('Plan a trip to')} ${q.trim()} ${t('with AI')}`}</b><small>{t('Or keep typing a sentence — riders, days, pace — and the builder opens with it.')}</small></span>
        </button>
      )}
      {text && savedList}
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
      {q.trim().length === 0 && paste && (
        <>
          <button className="hm-ai hm-paste" onClick={paste.onPaste}>
            <span className="hm-ai-glyph" aria-hidden="true">⧉</span>
            <span><b>{t('Open a shared link')}</b><small>{t('Paste a Roadbook link someone sent you.')}</small></span>
          </button>
          {paste.note && <p className="nb-note warn hm-paste-note">{paste.note}</p>}
        </>
      )}
      {!text && savedList}
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

// Is this the Home Screen app, or a browser tab?
const isStandalone = () => {
  try { return !!(navigator.standalone || window.matchMedia?.('(display-mode: standalone)').matches); } catch { return false; }
};

// A share link tapped on a phone opens in the BROWSER — an iPhone never hands
// a link to a Home Screen app, and the browser keeps its own copy of Roadbook
// (its own storage, its own sign-in). A rider who lives in the Home Screen app
// gets the way across: copy the link, open the app, paste it into the search.
function InAppHint({ token }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/#places=${token}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="hm-inapp">
      <b>{t('Using Roadbook from your Home Screen?')}</b>
      <p>{t('This link opened in your browser, which keeps its own copy of Roadbook. Copy it, open Roadbook from your Home Screen, and paste it into the search.')}</p>
      <button className="btn" onClick={copy}>{copied ? `✓ ${t('Copied')}` : t('Copy link')}</button>
    </div>
  );
}

// A list of places in the sheet: one of the rider's own (Favorites, or a list
// they made) or the places someone shared by link. Each row opens its card;
// the list can be shared as one link, renamed and deleted (the rider's own), or
// saved into the rider's places (a share).
function SavedListView({ kicker, title, rows, fix, onOpen, onBack, backLabel, onShare = null, onRename = null, onDelete = null, primary = null, empty = '', tone = 'saved', notice = null }) {
  const t = useT();
  const u = useUnits();
  const [renaming, setRenaming] = useState(false);
  const [armed, setArmed] = useState(false);
  return (
    <section className={`hm-list ${tone}`} aria-label={title}>
      <div className="hm-list-head">
        <button className="hm-round hm-list-back" onClick={onBack} aria-label={backLabel ?? t('Back')}>{backLabel ? '✕' : '‹'}</button>
        <div className="hm-list-title">
          <span className="mono">{kicker}</span>
          <b>{title}</b>
          <small>{rows.length} {rows.length === 1 ? t('place') : t('places')}</small>
        </div>
      </div>
      <div className="hm-list-actions">
        {primary && <button className="btn gold" onClick={primary.onClick}>{primary.label}</button>}
        {onShare && rows.length > 0 && <button className="btn" onClick={() => onShare(rows)}>{t('Share list')}</button>}
        {onRename && <button className="btn" onClick={() => setRenaming(true)}>{t('Rename')}</button>}
        {onDelete && (
          <button className={`btn${armed ? ' danger-ghost' : ''}`} onClick={() => (armed ? onDelete() : (setArmed(true), setTimeout(() => setArmed(false), 3000)))}>
            {armed ? t('Sure? Delete list') : t('Delete list')}
          </button>
        )}
      </div>
      {notice}
      {rows.length === 0 ? <p className="nb-note">{empty}</p> : (
        <ul className="hm-results hm-list-rows">
          {rows.map((p, i) => (
            <li key={p.id ?? `${p.lat},${p.lng},${i}`}>
              <button onClick={() => onOpen(p)}>
                <span className="hm-res-pin" aria-hidden="true">{p.role === 'home' ? '⌂' : p.role === 'work' ? '▣' : p.role === 'favorite' ? '★' : p.role ? '▤' : '◆'}</span>
                <span className="hm-res-main">
                  <b>{p.label ?? p.name}{p.saved ? <em className="hm-list-saved"> · ✓ {t('saved')}</em> : null}</b>
                  <small>{[p.address, fix ? `${u.miNum(haversineMiles(fix, p))} ${u.miUnit}` : ''].filter(Boolean).join(' · ')}</small>
                  {p.note && <small className="hm-list-note">{p.note}</small>}
                </span>
                <span className="mono hm-res-go">{t('Show')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {renaming && (
        <InputSheet title={t('Rename list')} label={t('Name')} defaultValue={title} submitLabel={t('Save')}
          onSubmit={(name) => onRename(name)} onClose={() => setRenaming(false)} />
      )}
    </section>
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

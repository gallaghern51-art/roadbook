import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { TripContext, reducer, initialState } from './engine/store.js';
import { routeDay } from './engine/routing.js';
import { tripSummary, tripPace, tripRoutePrefs, routePrefsKey } from './engine/tripEngine.js';
import { analyzeRouteChange, routeReconciliationPrompt } from './engine/routePreview.js';
import { tripFeasibility } from './engine/timeline.js';
import { useIsMobile } from './hooks/useMediaQuery.js';
import Home from './components/Home.jsx';
import Landing from './components/Landing.jsx';
import Ribbon from './components/Ribbon.jsx';
import MapView from './components/MapView.jsx';
import DayPanel from './components/DayPanel.jsx';
import OverviewPanel from './components/OverviewPanel.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import DetailModal from './components/DetailModal.jsx';
import NewTripModal from './components/NewTripModal.jsx';
import RideMode from './components/RideMode.jsx';
import PrepBoard from './components/PrepBoard.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import HelpGuide from './components/HelpGuide.jsx';
import { RoadbookBrand, SettingsIcon, ThemeToggle } from './components/Chrome.jsx';
import { ConfirmSheet, InputSheet } from './components/Sheets.jsx';
import { useTripSync } from './engine/useTripSync.js';
import { useAuth } from './engine/auth.js';
import { useLibraryBackup } from './engine/cloudLibrary.js';
import { useAutoTranslate } from './engine/autoTranslate.js';
import { usePlacePreferences } from './engine/placePreferences.js';
import { useProfile } from './engine/profile.js';
import { collabFor, saveCollab, clearCollab, collabApi, parseJoinParam, tripIdForShare } from './engine/collab.js';
import { useT, useUnits } from './engine/settings.jsx';

// The app is two screens:
//   HOME — the trip library and the AI intake. No map; nothing to draw yet.
//   TRIP — the workspace, with two working modes and one overlay:
//     PLAN — the map room: ribbon, map, day/overview panel. Route work.
//     PREP — the status board: grade, countdown, bookings, budget, packing.
//     RIDE — fullscreen navigation, launched from the mode bar.
// The AI is ONE surface — the Copilot dock — reachable from both modes, never
// a page of its own. Feasibility is a grade woven through every surface; the
// full study lives one tap deep on PREP.
const SCREEN_KEY = 'moto.screen.v1';
// "I looked at the landing page and chose to ride without an account." Sticky,
// or the front door would ask again on every launch — which is how a soft gate
// turns into a hard one by attrition.
const GUEST_KEY = 'moto.guest.v1';

// Language selection is the whole instruction: this watches for a language the
// trip is not translated into yet and fills it in, showing progress rather than
// asking for a click. Lives inside TripContext.Provider so it can read the trip.
function TranslationStatus() {
  const { progress } = useAutoTranslate();
  if (!progress) return null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <span className="xlate-pill" title={`${progress.done}/${progress.total}`}>
      <span className="xlate-bar"><i style={{ width: `${pct}%` }} /></span>
      translating {progress.done}/{progress.total}
    </span>
  );
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  if (import.meta.env.DEV) window.__dispatch = dispatch; // console/sim debugging, dev only
  // Sync rides alongside the reducer: it drains the outbox and replays other
  // riders' ops through the same apply_ops path. No-ops when not configured.
  const sync = useTripSync(state, dispatch);
  // Accounts sit alongside, not in the way: the reducer and localStorage are
  // untouched by whether anyone is signed in. An account only adds a mirror of
  // the library, so deleting the app stops being the same as losing the trips.
  const auth = useAuth();
  const placePreferences = usePlacePreferences(auth.account);
  const backup = useLibraryBackup(state, dispatch, auth.account);
  // The rider's own facts — saved places, how they ride, what they stop for.
  const profile = useProfile(auth.account);
  const [guest, setGuest] = useState(() => {
    try { return localStorage.getItem(GUEST_KEY) === '1'; } catch { return false; }
  });
  const continueAsGuest = () => {
    try { localStorage.setItem(GUEST_KEY, '1'); } catch { /* non-fatal */ }
    setGuest(true);
  };
  // Signing in retires the guest choice, so signing out later lands back on the
  // front door rather than silently dropping into an unbacked-up library.
  useEffect(() => {
    if (!auth.account) return;
    try { localStorage.removeItem(GUEST_KEY); } catch { /* non-fatal */ }
    setGuest(false);
  }, [auth.account]);
  const [routes, setRoutes] = useState({}); // dayId -> {legs, geometry}
  const [routeLoad, setRouteLoad] = useState(null); // latest-only whole-trip route calculation
  const [routePreview, setRoutePreview] = useState(null); // staged route character; never mutates the trip
  const routePreviewControllerRef = useRef(null);
  const [screen, setScreen] = useState(() => {
    try { return localStorage.getItem(SCREEN_KEY) || 'home'; } catch { return 'home'; }
  });
  const [mode, setMode] = useState('plan'); // plan | prep
  const [prepFocus, setPrepFocus] = useState(null); // null | feasibility | budget | packing | bookings | file
  const [dockOpen, setDockOpen] = useState(false); // the Copilot dock
  const [sheet, setSheet] = useState(null); // { type: settings|help|save-scenario|reset|delete-trip, ... }
  // The guide on the signed-out door cannot ride the sheet stack: Landing
  // returns before it is rendered.
  const [helpOnLanding, setHelpOnLanding] = useState(false);
  const [newTrip, setNewTrip] = useState(null); // { tab, prompt } while the modal is open
  const [rideOpen, setRideOpen] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false); // desktop: fold the side panel away, map takes the room
  const t = useT();
  const u = useUnits();
  const isMobile = useIsMobile();
  const [panelOpen, setPanelOpen] = useState(false); // the side panel over the map
  const fileRef = useRef(null);

  // ---- collaborate mode ----
  const [collabInfo, setCollabInfo] = useState(() => collabFor(state.lib.activeId));
  const [crew, setCrew] = useState(null); // latest pulled share state
  const [collabBusy, setCollabBusy] = useState(false);
  const [collabError, setCollabError] = useState(null);
  const [joinReq, setJoinReq] = useState(() => parseJoinParam()); // ?join=… in the URL
  const crewRef = useRef(null);
  crewRef.current = crew;
  const pendingJoinRef = useRef(null); // collab record awaiting the new trip id
  const opLogRef = useRef(state.opLog);
  opLogRef.current = state.opLog;

  useEffect(() => {
    try { localStorage.setItem(SCREEN_KEY, screen); } catch { /* non-fatal */ }
  }, [screen]);

  // A link can point straight at the guide — #help, or #help-ride for one
  // chapter. That is the link you send a friend who has just installed it,
  // so it has to work on the signed-out door too.
  useEffect(() => {
    const read = () => {
      const hash = (window.location.hash || '').replace(/^#/, '');
      if (!hash.startsWith('help')) return;
      const chapter = hash.includes('-') ? hash.slice(hash.indexOf('-') + 1) : undefined;
      setSheet({ type: 'help', chapter });
      setHelpOnLanding(true);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  // Closing the guide drops the hash, or reopening the app would land back in it.
  const closeHelp = () => {
    setSheet(null);
    setHelpOnLanding(false);
    if ((window.location.hash || '').startsWith('#help')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  };

  // Route every day whenever its waypoint sequence OR the trip-wide road
  // character changes. The same preferences also flow into Ride Mode.
  const routePrefs = tripRoutePrefs(state.trip);
  const routeSignature = routePrefsKey(routePrefs) + '|' + state.trip.days
    .map((d) => d.id + ':' + d.waypoints.map((w) => `${w.lat.toFixed(4)},${w.lng.toFixed(4)}`).join(';'))
    .join('|');

  const closeRoutePreview = () => {
    routePreviewControllerRef.current?.abort();
    routePreviewControllerRef.current = null;
    setRoutePreview(null);
  };

  const beginRoutePreview = (nextPrefs) => {
    if (routePrefsKey(nextPrefs) === routePrefsKey(routePrefs)) return;
    routePreviewControllerRef.current?.abort();
    const controller = new AbortController();
    routePreviewControllerRef.current = controller;
    const trip = state.trip;
    const baseSignature = routeSignature;
    const currentRoutes = routes;
    const days = trip.days;
    const nextRoutes = {};
    let cursor = 0;
    setRoutePreview({ prefs: nextPrefs, baseSignature, status: 'loading', done: 0, total: days.length, routes: null, analysis: null, error: null });
    (async () => {
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= days.length) return;
          const day = days[index];
          nextRoutes[day.id] = await routeDay(day, nextPrefs, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setRoutePreview((current) => (
            current?.baseSignature === baseSignature
              ? { ...current, done: Object.keys(nextRoutes).length }
              : current
          ));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, days.length) }, worker));
      if (controller.signal.aborted) return;
      const analysis = analyzeRouteChange(trip, currentRoutes, nextRoutes, nextPrefs);
      setRoutePreview((current) => (
        current?.baseSignature === baseSignature
          ? { ...current, status: 'ready', done: days.length, routes: nextRoutes, analysis }
          : current
      ));
    })().catch((error) => {
      if (error?.name === 'AbortError') return;
      setRoutePreview((current) => (
        current?.baseSignature === baseSignature
          ? { ...current, status: 'error', error: error?.message || 'Route comparison failed.' }
          : current
      ));
    });
  };

  const applyRoutePreview = () => {
    if (routePreview?.status !== 'ready') return;
    // A collaborator may have edited the trip behind the comparison sheet.
    // Recalculate against the new facts rather than applying a stale draft.
    if (routePreview.baseSignature !== routeSignature) {
      beginRoutePreview(routePreview.prefs);
      return;
    }
    setRoutes(routePreview.routes);
    dispatch({ type: 'apply_ops', ops: [{ op: 'set_meta', patch: { routePrefs: routePreview.prefs } }] });
    closeRoutePreview();
  };

  const researchRouteAlternatives = (styleLabel) => {
    if (routePreview?.status !== 'ready') return;
    dispatch({ type: 'ask_optimizer', text: routeReconciliationPrompt(state.trip, routePreview, styleLabel) });
    closeRoutePreview();
  };

  useEffect(() => () => routePreviewControllerRef.current?.abort(), []);
  useEffect(() => {
    closeRoutePreview();
  }, [state.lib.activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const controller = new AbortController();
    const days = state.trip.days;
    const nextRoutes = {};
    let cursor = 0;
    setRouteLoad({ signature: routeSignature, style: routePrefs.style, done: 0, total: days.length });
    (async () => {
      // A small worker pool is materially faster than routing a long trip one
      // day at a time without stampeding the public Valhalla service.
      const worker = async () => {
        while (!controller.signal.aborted) {
          const index = cursor++;
          if (index >= days.length) return;
          const day = days[index];
          nextRoutes[day.id] = await routeDay(day, routePrefs, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const done = Object.keys(nextRoutes).length;
          setRouteLoad((current) => (current?.signature === routeSignature ? { ...current, done } : current));
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, days.length) }, worker));
      if (controller.signal.aborted) return;
      // Swap the route set atomically. The map can now never show a mixture of
      // old and new route characters or apply a superseded click late.
      setRoutes(nextRoutes);
      setRouteLoad((current) => (current?.signature === routeSignature ? null : current));
    })().catch((e) => {
      if (e?.name !== 'AbortError') console.warn('route calculation failed', e);
    });
    return () => controller.abort();
  }, [routeSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cached legs are unpaced; the trip's group-pace multiplier is applied here,
  // in one place, so every consumer (timeline, feasibility, exports, digests)
  // sees the same paced durations and a pace edit retimes everything instantly.
  const pace = tripPace(state.trip);
  const routedLegsByDay = useMemo(() => {
    const out = {};
    for (const [id, r] of Object.entries(routes)) {
      out[id] = {};
      for (const [k, leg] of Object.entries(r.legs)) {
        out[id][k] = leg.seconds != null ? { ...leg, seconds: leg.seconds * pace } : leg;
      }
    }
    return out;
  }, [routes, pace]);

  const summary = useMemo(() => tripSummary(state.trip, routedLegsByDay), [state.trip, routedLegsByDay]);
  // One computation of the grade system, shared by the ribbon, Home, and PREP.
  const feas = useMemo(() => tripFeasibility(state.trip, routedLegsByDay), [state.trip, routedLegsByDay]);
  const selectedDay = state.trip.days.find((d) => d.id === state.selectedDayId) ?? null;

  const showPanel = () => setPanelOpen(true);
  const ui = {
    isMobile, panelOpen, setPanelOpen, showPanel, routeLoad,
    routePreview, beginRoutePreview, closeRoutePreview, applyRoutePreview, researchRouteAlternatives,
  };

  // A new day is a new page: without this the panel keeps the previous day's
  // scroll depth and opens somewhere in the middle of the next one.
  const sideInnerRef = useRef(null);
  useEffect(() => {
    sideInnerRef.current?.scrollTo({ top: 0 });
  }, [state.selectedDayId]);

  // Selecting a day from anywhere — ribbon, feasibility rows, map, modals — is
  // a planning act: land in PLAN with the panel on screen.
  useEffect(() => {
    if (state.selectedDayId) {
      setMode('plan');
      setPanelOpen(true);
    }
  }, [state.selectedDayId]);

  // Mid-trip, entering a trip lands on TODAY's day — once per trip entry, and
  // never over an explicit selection. Before/after the trip there is no
  // "today" to land on and the trip overview stands as before.
  const autoTodayRef = useRef(null);
  useEffect(() => {
    if (screen !== 'trip' || autoTodayRef.current === state.lib.activeId) return;
    autoTodayRef.current = state.lib.activeId;
    if (state.selectedDayId) return;
    const today = new Date().toLocaleDateString('sv-SE');
    const d = state.trip.days.find((x) => x.date === today);
    if (d) dispatch({ type: 'select_day', dayId: d.id });
  }, [screen, state.lib.activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A question queued for the AI (feasibility handoffs, PREP hero) opens the
  // dock; the chat mounts, sees the ask, and sends it.
  useEffect(() => {
    if (state.chatAsk) setDockOpen(true);
  }, [state.chatAsk]);

  // Tapping a leg's figures zooms the map to that leg — on a phone the panel
  // covers the map, so it steps aside to show what was asked for.
  useEffect(() => {
    if (state.focusLeg?.zoom && isMobile) setPanelOpen(false);
  }, [state.focusLeg?.zoom, isMobile]);
  // Reopening the panel is the way back — the highlight has done its job.
  useEffect(() => {
    if (isMobile && panelOpen && state.focusLeg) dispatch({ type: 'focus_leg', leg: null });
  }, [panelOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportJson = () => {
    const slug = (state.trip.meta.title || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const blob = new Blob([JSON.stringify(state.trip, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug || 'trip'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // Import always creates a NEW library record — replacing the working trip
  // with whatever a file held was the old behavior and a data-loss trap.
  const importJson = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const trip = JSON.parse(await file.text());
      if (!trip?.days?.length) throw new Error('not a trip file');
      dispatch({ type: 'create_trip', trip });
      setScreen('trip');
      setMode('plan');
      setPanelOpen(true);
    } catch (err) {
      alert(`Could not import: ${err.message}`);
    }
    e.target.value = '';
  };

  useEffect(() => {
    document.title = screen === 'home' ? 'Roadbook' : `${state.trip.meta.title} · Roadbook`;
  }, [state.trip.meta.title, screen]);

  const askAI = (text) => {
    dispatch({ type: 'ask_optimizer', text });
    setDockOpen(true);
  };

  // ---- collaborate mode plumbing ----
  // Membership follows the active trip; crew state resets on switch.
  useEffect(() => {
    setCollabInfo(collabFor(state.lib.activeId));
    setCrew(null);
    setCollabError(null);
  }, [state.lib.activeId]);

  const refreshCrew = async () => {
    const info = collabFor(state.lib.activeId);
    if (!info) return;
    try {
      const d = await collabApi({ action: 'pull', shareId: info.shareId, key: info.key });
      if (d.state) {
        setCrew(d.state);
        setCollabError(null);
        // A rider with no unsent edits adopts the group's plan silently.
        if (d.state.me?.role === 'rider' && d.state.rev !== info.lastRev && opLogRef.current.length === 0) {
          dispatch({ type: 'sync_trip', trip: d.state.trip });
          saveCollab(state.lib.activeId, { ...info, lastRev: d.state.rev });
          setCollabInfo({ ...info, lastRev: d.state.rev });
        }
      }
    } catch (e) {
      // A share that no longer knows us (removed from the crew, or the share
      // is gone) is not an error to keep showing — release the membership and
      // the trip becomes a normal local trip again.
      if (e.status === 403 || e.status === 404) {
        clearCollab(state.lib.activeId);
        setCollabInfo(null);
        setCrew(null);
        setCollabError(null);
      } else {
        setCollabError(String(e.message ?? e));
      }
    }
  };
  const refreshCrewRef = useRef(refreshCrew);
  refreshCrewRef.current = refreshCrew;

  // Poll while the trip is on screen. 10s is plenty for trip planning; hidden
  // tabs skip the tick and catch up the moment they come back.
  useEffect(() => {
    if (screen !== 'trip' || !collabInfo) return undefined;
    refreshCrewRef.current();
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshCrewRef.current();
    }, 10000);
    const onVis = () => { if (document.visibilityState === 'visible') refreshCrewRef.current(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [screen, collabInfo?.shareId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The captain's working trip is the group's trip: push edits, debounced.
  const pushTimerRef = useRef(null);
  useEffect(() => {
    const info = collabFor(state.lib.activeId);
    if (!info || info.role !== 'captain') return undefined;
    clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      collabApi({ action: 'push_trip', shareId: info.shareId, key: info.key, trip: state.trip })
        .then((d) => saveCollab(state.lib.activeId, { ...info, lastRev: d.rev }))
        .catch((e) => setCollabError(String(e.message ?? e)));
    }, 1500);
    return () => clearTimeout(pushTimerRef.current);
  }, [state.trip]); // eslint-disable-line react-hooks/exhaustive-deps

  const startShare = async (name) => {
    setCollabBusy(true);
    setCollabError(null);
    try {
      const d = await collabApi({ action: 'create', trip: state.trip, name });
      const rec = { shareId: d.shareId, key: d.key, role: 'captain', name, lastRev: d.state.rev };
      saveCollab(state.lib.activeId, rec);
      setCollabInfo(rec);
      setCrew(d.state);
    } catch (e) {
      setCollabError(String(e.message ?? e));
    } finally {
      setCollabBusy(false);
    }
  };

  const collabAct = async (action, extra = {}) => {
    const info = collabFor(state.lib.activeId);
    if (!info) return;
    try {
      await collabApi({ action, shareId: info.shareId, key: info.key, ...extra });
      await refreshCrewRef.current();
    } catch (e) {
      setCollabError(String(e.message ?? e));
    }
  };

  // Joining from an invite link: the share's trip becomes a new library record;
  // the membership record attaches once the reducer has minted the trip id.
  const joinShare = async (name) => {
    if (!joinReq || collabBusy) return; // a slow join must not double-fire
    // Tapping the same invite twice reopens the trip instead of joining a copy.
    const existing = tripIdForShare(joinReq.shareId);
    if (existing && state.lib.trips.some((r) => r.id === existing)) {
      setJoinReq(null);
      window.history.replaceState(null, '', location.pathname);
      openTrip(existing);
      return;
    }
    setCollabBusy(true);
    try {
      const d = await collabApi({ action: 'join', shareId: joinReq.shareId, joinCode: joinReq.joinCode, name });
      pendingJoinRef.current = { shareId: joinReq.shareId, key: d.key, role: 'rider', name, lastRev: d.state.rev };
      dispatch({ type: 'create_trip', trip: d.state.trip });
      setJoinReq(null);
      window.history.replaceState(null, '', location.pathname);
      setScreen('trip');
      setMode('prep');
      setPrepFocus('crew');
    } catch (e) {
      setCollabError(String(e.message ?? e));
      setJoinReq(null);
    } finally {
      setCollabBusy(false);
    }
  };
  useEffect(() => {
    if (!pendingJoinRef.current) return;
    saveCollab(state.lib.activeId, pendingJoinRef.current);
    setCollabInfo(pendingJoinRef.current);
    pendingJoinRef.current = null;
  }, [state.lib.activeId]);

  const collab = { info: collabInfo, crew, busy: collabBusy, error: collabError, refresh: () => refreshCrewRef.current(), start: startShare, act: collabAct };

  const openTrip = (id) => {
    if (id !== state.lib.activeId) dispatch({ type: 'switch_trip', id });
    setScreen('trip');
    setMode('plan');
    setPrepFocus(null);
    setPanelOpen(true);
  };

  // On the phone's map the header and ribbon float over it, so the map has to
  // know how tall they are — its own overlays sit below them. Measured rather
  // than guessed: the masthead grows a line when a trip title wraps.
  //
  // Measured more than once on purpose. iOS standalone lays the app out against
  // a stale viewport at launch (the same fault main.jsx mirrors innerHeight into
  // --app-h for), and a ResizeObserver that fires while the chrome is still 0px
  // high leaves the map's furniture pinned to the top of the screen — under the
  // status bar, which is what a PWA rider actually sees. So: measure on mount,
  // measure again after paint, and re-measure on every event that can follow a
  // stale layout. A zero is never written; the last good height stands until a
  // real one replaces it.
  const appRef = useRef(null);
  const chromeRef = useRef(null);
  useEffect(() => {
    const app = appRef.current;
    if (!app) return undefined;
    const measure = () => {
      const chrome = chromeRef.current;
      if (!chrome) return;
      const h = Math.round(chrome.getBoundingClientRect().height);
      if (h > 0) app.style.setProperty('--chrome-h', `${h}px`);
    };
    measure();
    // Delayed ticks catch the launch layout settling; the events catch rotation,
    // the keyboard, and coming back from the background.
    const timers = [0, 60, 250, 800].map((ms) => setTimeout(measure, ms));
    const events = ['resize', 'orientationchange', 'pageshow', 'visibilitychange'];
    for (const e of events) window.addEventListener(e, measure);
    window.visualViewport?.addEventListener('resize', measure);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && chromeRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(chromeRef.current);
    }
    return () => {
      timers.forEach(clearTimeout);
      for (const e of events) window.removeEventListener(e, measure);
      window.visualViewport?.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [screen]);

  const mapFull = isMobile && !panelOpen && mode === 'plan';

  // ONE mode bar, rendered where each layout puts it: fixed bottom on the
  // phone, a row under the masthead on desktop. PLAN and PREP are places;
  // RIDE is the trip's action and keeps its color.
  const ModeBar = () => (
    <nav className={`tabnav modebar${isMobile ? '' : ' deskbar'}`} aria-label="Modes">
      <button
        className={mode === 'plan' ? 'active' : ''}
        aria-current={mode === 'plan'}
        onClick={() => {
          // tapping PLAN while planning toggles the panel back to bare map
          if (mode === 'plan' && isMobile) setPanelOpen(!panelOpen);
          else { setMode('plan'); setPanelOpen(true); }
        }}
      >{t('Plan')}</button>
      <button
        className={mode === 'prep' ? 'active' : ''}
        aria-current={mode === 'prep'}
        onClick={() => {
          if (mode === 'prep') setPrepFocus(null);
          setMode('prep');
          dispatch({ type: 'select_day', dayId: null });
        }}
      >{t('Prep')}</button>
      <button className="ride-seat" onClick={() => setRideOpen(true)}>
        <svg viewBox="0 0 16 16" className="play-tri" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor" /></svg>
        {t('Ride')}
      </button>
    </nav>
  );

  const sheets = (
    <>
      {/* The guide depends on nothing but the settings provider, so the same
          sheet serves home, a trip, and a link arriving cold at #help. */}
      {sheet?.type === 'help' && (
        <HelpGuide initialChapter={sheet.chapter} onClose={closeHelp} />
      )}
      {sheet?.type === 'settings' && (
        <div className="modal-backdrop" onClick={() => setSheet(null)}>
          <div className="modal settings" onClick={(e) => e.stopPropagation()}>
            <button className="btn sheet-x" onClick={() => setSheet(null)}>✕</button>
            <SettingsModal
              sync={sync}
              auth={auth}
              backup={backup}
              profile={profile}
              onCreateAccount={() => {
                try { localStorage.removeItem(GUEST_KEY); } catch { /* non-fatal */ }
                setGuest(false);
                setSheet(null);
              }}
              onHelp={() => setSheet({ type: 'help' })}
            />
          </div>
        </div>
      )}
      {sheet?.type === 'save-scenario' && (
        <InputSheet
          title={t('Save scenario')}
          label={t('Name this trip permutation')}
          placeholder={t('e.g. Relaxed — lower miles')}
          submitLabel={t('Save')}
          onSubmit={(name) => dispatch({ type: 'save_scenario', name })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.type === 'reset' && (
        <ConfirmSheet
          danger
          title={t('Reset this trip?')}
          body={t('Back to the bundled Sturgis template. Every edit to this trip is discarded.')}
          confirmLabel={t('Reset')}
          onConfirm={() => dispatch({ type: 'reset' })}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet?.type === 'delete-trip' && (
        <ConfirmSheet
          danger
          title={t('Delete this trip?')}
          body={`“${sheet.rec.name}” — ${t('its days, scenarios, and chat go with it. There is no undo for this.')}`}
          confirmLabel={t('Delete')}
          onConfirm={() => { clearCollab(sheet.rec.id); dispatch({ type: 'delete_trip', id: sheet.rec.id }); }}
          onClose={() => setSheet(null)}
        />
      )}
    </>
  );

  const ctx = { state, dispatch, routes, routedLegsByDay, summary, feas, ui, collab, placePreferences, profile };

  // The join sheet rides over either screen — a link can arrive cold.
  const joinSheet = joinReq && (
    <InputSheet
      title={t('Join this ride?')}
      label={t('Your name — shown to the crew')}
      placeholder={t('e.g. Marco')}
      submitLabel={collabBusy ? t('Joining…') : t('Join the crew')}
      onSubmit={(name) => joinShare(name)}
      onClose={() => { setJoinReq(null); window.history.replaceState(null, '', location.pathname); }}
    />
  );

  // ---- the front door ----
  // Held until the stored session has been read back, or a signed-in rider gets
  // a flash of the landing page on every launch. Nothing renders in the gap:
  // the app's own first paint is a map, and a spinner in front of it would be
  // slower to arrive than the real thing.
  if (auth.status === 'loading') return <div className="landing-hold" />;
  // A password-reset link wins over everything — the tab is carrying a recovery
  // session and there is nothing to do in the app until it is spent.
  if (auth.recovery || auth.finishAccount || (auth.enabled && !auth.account && !guest)) {
    return (
      <Landing
        onHelp={() => setHelpOnLanding(true)}
        onGuest={continueAsGuest}
        recovery={auth.recovery}
        finishAccount={auth.finishAccount}
        onRecovered={auth.clearRecovery}
        onFinished={auth.clearFinishAccount}
      >
        {helpOnLanding && <HelpGuide initialChapter={sheet?.type === 'help' ? sheet.chapter : undefined} onClose={closeHelp} />}
      </Landing>
    );
  }

  // ---- HOME ----
  if (screen === 'home') {
    return (
      <TripContext.Provider value={ctx}>
        <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importJson} />
        <Home
          onOpenTrip={openTrip}
          onNewTrip={(init) => setNewTrip(init)}
          onImport={() => fileRef.current?.click()}
          onDeleteTrip={(rec) => setSheet({ type: 'delete-trip', rec })}
          onSettings={() => setSheet({ type: 'settings' })}
          onHelp={() => setSheet({ type: 'help' })}
        />
        {newTrip && (
          <NewTripModal
            initial={newTrip}
            account={auth.account}
            profile={profile.profile}
            onClose={() => setNewTrip(null)}
            onCreated={() => { setNewTrip(null); setScreen('trip'); setMode('plan'); setPanelOpen(true); }}
          />
        )}
        {joinSheet}
        {sheets}
      </TripContext.Provider>
    );
  }

  // ---- TRIP ----
  return (
    <TripContext.Provider value={ctx}>
      <div ref={appRef} className={`app${isMobile ? ' mobile' : ''}${mapFull ? ' map-full' : ''}${mode === 'prep' ? ' prep-mode' : ''}`}>
        <div className="topchrome" ref={chromeRef}>
          <header className="masthead">
            {/* the way OUT of a trip was tapping the wordmark — invisible.
                A real back control, sized for gloves. */}
            <button className="mast-back" title={t('Your trips')} aria-label={t('Your trips')} onClick={() => setScreen('home')}>‹</button>
            <div className="mast-id">
              <h1 className="brand">
                <button onClick={() => setScreen('home')} title={t('Your trips')}><RoadbookBrand /></button>
              </h1>
              <span className="sub">
                <span className="mast-trip">{state.trip.meta.title}</span>
                <span className="mast-stats">
                  {u.mi(summary.totalMiles)} · {state.trip.meta.riders} {t('riders')} · {state.trip.days.length} {t('days')}
                </span>
                <TranslationStatus />
              </span>
            </div>
            <div className="actions">
              <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={importJson} />
              {state.history.length > 0 && (
                <button className="btn" onClick={() => dispatch({ type: 'undo' })}>{t('Undo')}</button>
              )}
              <ThemeToggle />
              <button className="btn icon" title={t('Settings')} aria-label={t('Settings')} onClick={() => setSheet({ type: 'settings' })}><SettingsIcon /></button>
            </div>
          </header>
          {!isMobile && <ModeBar />}
          <Ribbon />
          {crew?.status === 'published' && (
            <div className="pub-strip">
              ⚑ {t('Published plan')} — {collabInfo?.role === 'captain'
                ? t('reopen planning from the Crew board to edit')
                : t('your edits arrive as proposals to the captain')}
            </div>
          )}
        </div>

        {/* PLAN stays mounted under PREP so the map keeps its state; the
            ResizeObserver in MapView resizes it when it comes back. */}
        <div
          className="main"
          data-panel={isMobile && panelOpen ? 'open' : 'closed'}
          data-collapsed={!isMobile && panelCollapsed ? 'yes' : 'no'}
        >
          <MapView />
          {/* the visible strip of map beside the open panel dismisses it —
              tapping what you want to get back to is the gesture */}
          {isMobile && panelOpen && (
            <button className="panel-scrim" aria-label={t('Back to the map')} onClick={() => setPanelOpen(false)} />
          )}
          <aside className="side">
            {/* the panel's own hide handle — the seat-toggle gesture was
                invisible; a control you can see is one you can find */}
            <button
              className="panel-tab"
              aria-label={isMobile || !panelCollapsed ? t('Hide the panel') : t('Show the panel')}
              title={isMobile || !panelCollapsed ? t('Hide the panel') : t('Show the panel')}
              onClick={() => (isMobile ? setPanelOpen(false) : setPanelCollapsed((v) => !v))}
            >{!isMobile && panelCollapsed ? '‹' : '›'}</button>
            <div className="side-inner" ref={sideInnerRef}>
              {selectedDay ? <DayPanel day={selectedDay} /> : <OverviewPanel />}
            </div>
          </aside>
        </div>
        {mode === 'prep' && (
          <div className="prep-main">
            <div className="prep-inner">
              <PrepBoard
                focus={prepFocus}
                setFocus={setPrepFocus}
                onAskAI={askAI}
                onSaveScenario={() => setSheet({ type: 'save-scenario' })}
                onExportJson={exportJson}
                onImportJson={() => fileRef.current?.click()}
                onReset={() => setSheet({ type: 'reset' })}
              />
            </div>
          </div>
        )}

        {isMobile && <ModeBar />}

        {/* The AI's one door. The dot means a proposal is waiting. */}
        {!dockOpen && !rideOpen && (!isMobile || !panelOpen) && (
          <button
            className={`dock-fab${state.pendingProposal ? ' has-proposal' : ''}`}
            onClick={() => setDockOpen(true)}
          >✦ {t('Copilot')}</button>
        )}
        {dockOpen && (
          <div className="ai-dock">
            <ChatPanel onClose={() => setDockOpen(false)} />
          </div>
        )}

        <DetailModal />
        {newTrip && (
          <NewTripModal
            initial={newTrip}
            account={auth.account}
            profile={profile.profile}
            onClose={() => setNewTrip(null)}
            onCreated={() => { setNewTrip(null); setMode('plan'); setPanelOpen(true); }}
          />
        )}
        {rideOpen && <RideMode onClose={() => setRideOpen(false)} />}
        {joinSheet}
        {sheets}
      </div>
    </TripContext.Provider>
  );
}

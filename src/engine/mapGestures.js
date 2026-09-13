// A long press on the map drops a pin — Google's grammar, on both maps
// (owner, Sep 13 2026: "long-press on open map DROPS A PIN… a plain tap must
// NOT drop a pin — on a phone a tap is how you dismiss").
//
// Three doors, one callback:
//   · a right-click on a desktop — mapbox-gl's own `contextmenu` event
//   · a long press on Android — Chrome synthesises `contextmenu` for it too
//   · a long press on iOS — Safari never does, so a timer on the canvas's
//     own POINTER events stands in: one touch pointer, held HOLD_MS, that
//     never travels more than SLOP_PX and never starts a map move (a pinch
//     or a pan cancels it, so pan/zoom can never drop a pin)
// Pointer events, not touch events; the hold is judged at RELEASE as well
// as by the timer; and it is measured on the events' own `timeStamp`s, never
// on when they were dispatched — three facts, all load-bearing, all measured
// on the iOS simulator (iPhone 17 Pro, Safari) with an on-screen event log:
//   · WebKit holds `touchstart` back ~550 ms while it decides what the
//     gesture is (a touch-event timer saw a 290 ms "hold" for a finger that
//     was down 840 ms);
//   · it runs no JS timers while the finger stays down (a 500 ms timer
//     armed on pointerdown had not fired when pointerup arrived 870 ms
//     later), so a finger released after HOLD_MS is the press;
//   · and it DEFERS the pointer events themselves, by a varying amount
//     (`pointerdown` dispatched 1,430 ms after the finger landed, `pointerup`
//     821 ms after it lifted — the same 900 ms hold read as 312 ms, 432 ms
//     and 870 ms of "held" across runs when measured at dispatch), while
//     each event's `timeStamp` keeps the hardware time (946 ms apart for
//     that hold). So the press is `up.timeStamp − down.timeStamp ≥ HOLD_MS`.
// The timer still fires mid-hold where the engine lets it (Android, desktop
// touch); on iOS the pin lands as the finger lifts.
// The two contextmenu doors and the timer can both fire for one press on
// Android; a fire within DEDUPE_MS of the last is the same press.
//
// Presses that begin on anything but the canvas itself (a stop marker, a
// place pin, a control) are not the map's — a long press on a marker is
// that marker's business (its drag), never a pin under it.
//
// `recent()` is the tap-honesty half: after a press fires, the release that
// follows can still reach the map as a `click`, and the click handlers
// (dismiss, click-to-add, POI hit-test) must ignore it — a pin drop that
// also dismissed its own card would be no drop at all.
//
//   const lp = attachLongPress(map, ({ lat, lng }) => …);
//   map.on('click', (e) => { if (lp.recent()) return; … });
//   lp.detach();
export const HOLD_MS = 500;
export const SLOP_PX = 10;
export const DEDUPE_MS = 350;
export const SWALLOW_MS = 700;

export function attachLongPress(map, onLongPress, { hold = HOLD_MS, slop = SLOP_PX, now = () => Date.now() } = {}) {
  let timer = null;
  let press = null; // { id, x, y } — the one touch pointer that is down
  let firedAt = -Infinity;

  const fire = (lngLat) => {
    const t = now();
    if (t - firedAt < DEDUPE_MS) return; // Android: contextmenu + the timer, one press
    firedAt = t;
    onLongPress?.({ lat: lngLat.lat, lng: lngLat.lng });
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    press = null;
  };

  // door 1 + 2: mapbox-gl's contextmenu carries a lngLat already
  const onContext = (e) => {
    e.preventDefault?.();
    e.originalEvent?.preventDefault?.();
    cancel();
    fire(e.lngLat);
  };
  map.on('contextmenu', onContext);

  // door 3: the timer. DOM pointer events on the canvas container (mapbox-gl's
  // own listeners live there), never map events — map.on('touchstart') is
  // preventable and a marker's stopPropagation must still reach us as
  // "not the map's press".
  const container = map.getCanvasContainer();
  const canvas = map.getCanvas();
  const dropAt = (p) => { const r = canvas.getBoundingClientRect(); fire(map.unproject([p.x - r.left, p.y - r.top])); };
  // the event's own clock: the hardware time on engines that defer dispatch
  const stamp = (ev) => (Number.isFinite(ev.timeStamp) && ev.timeStamp > 0 ? ev.timeStamp : now());
  const onDown = (ev) => {
    if (ev.pointerType !== 'touch') return; // a mouse has its right button
    if (press || ev.target !== canvas) { cancel(); return; } // a second finger, or a marker's touch
    press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, t: stamp(ev) };
    timer = setTimeout(() => {
      timer = null;
      const p = press;
      press = null;
      if (p) dropAt(p);
    }, hold);
  };
  const onMove = (ev) => {
    if (!press || ev.pointerId !== press.id) return;
    if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > slop) cancel();
  };
  const onUp = (ev) => {
    if (!press || ev.pointerId !== press.id) return;
    const p = press;
    cancel();
    // the release of a finger that was held long enough IS the press when the
    // engine never ran the timer (iOS) — held per the events' own timestamps,
    // since dispatch can lag the finger by over a second; a cancel (the
    // system took the gesture) is not
    if (ev.type === 'pointerup' && stamp(ev) - p.t >= hold) dropAt(p);
  };
  const onMoveStart = () => cancel(); // a pan or a pinch began — not a press
  container.addEventListener('pointerdown', onDown, { passive: true });
  container.addEventListener('pointermove', onMove, { passive: true });
  container.addEventListener('pointerup', onUp, { passive: true });
  container.addEventListener('pointercancel', onUp, { passive: true });
  map.on('movestart', onMoveStart);

  return {
    /** True for a short window after a press fired: the click that follows it is not a tap. */
    recent: () => now() - firedAt < SWALLOW_MS,
    detach() {
      cancel();
      map.off('contextmenu', onContext);
      map.off('movestart', onMoveStart);
      container.removeEventListener('pointerdown', onDown);
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
      container.removeEventListener('pointercancel', onUp);
    },
  };
}

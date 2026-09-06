// Unit tests for the rebuilt ride-nav destination engine — every edge case
// enumerated in the module doc, pure node, no browser.
import {
  createNav, syncNav, navTarget, navRemaining, navFix,
  navGoNext, navSkip, navRestore, navInitVisited, navArriveAt, ARRIVE_MI,
} from '../../src/engine/rideNav.js';

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

// A day: S — CABIN (spur) — DINER — RUSHMORE — LODGE(final). ~0.01° lat ≈ 0.7 mi.
const wps = [
  { id: 's', name: 'Start', lat: 44.00, lng: -103.60 },
  { id: 'cabin', name: 'Cozy Cabin', lat: 44.10, lng: -103.60 },
  { id: 'diner', name: 'Hill City Diner', lat: 44.10, lng: -103.50 },
  { id: 'rush', name: 'Mount Rushmore', lat: 44.05, lng: -103.45 },
  { id: 'lodge', name: 'End Lodge', lat: 44.00, lng: -103.40 },
];
const at = (id) => wps.find((w) => w.id === id);
const feed = (nav, fixes, ctx) => {
  const all = [];
  for (const f of fixes) {
    const r = navFix(nav, wps, f, ctx);
    nav = r.nav; all.push(...r.events);
  }
  return { nav, events: all };
};

// 1+2. Parked ON the cabin while it isn't the target: latches; leaving can't resurrect it.
{
  let nav = createNav();
  ({ nav } = navFix(nav, wps, { lat: 44.00, lng: -103.60 })); // at start → latches 's'
  check(nav.visited.has('s'), 'start latches on departure fix');
  // park at the cabin — the target after 's' IS the cabin, but simulate the old
  // failure shape anyway: latch, then move away with NO projection to rewind
  ({ nav } = navFix(nav, wps, { lat: 44.10, lng: -103.60 }));
  check(nav.visited.has('cabin'), 'parked-at latches the cabin');
  const { nav: n2 } = feed(nav, [
    { lat: 44.08, lng: -103.60 }, { lat: 44.06, lng: -103.60 }, { lat: 44.04, lng: -103.60 },
  ], { onRoute: true });
  check(navTarget(n2, wps).id === 'diner', 'leaving by the arrival road: target stays the diner');
  check(navRemaining(n2, wps).every((w) => w.id !== 'cabin'), 'the cabin never re-enters remaining');
  nav = n2;

  // 3. Winding approach: distance to the DINER grows over 5 fixes while ON route → no auto-skip.
  const wind = feed(nav, [
    { lat: 44.095, lng: -103.505 }, // 0.35 mi-ish close approach
    { lat: 44.09, lng: -103.52 },
    { lat: 44.085, lng: -103.53 },
    { lat: 44.08, lng: -103.54 },
    { lat: 44.075, lng: -103.55 },
  ], { onRoute: true });
  check(!wind.events.some((e) => e.type === 'autoskip'), 'winding on-route approach never auto-skips the target');
  check(navTarget(wind.nav, wps).id === 'diner', 'target holds through the switchbacks');

  // 4. The same movement OFF route → auto-skip fires, undoably.
  const off = feed(nav, [
    { lat: 44.095, lng: -103.505 },
    { lat: 44.09, lng: -103.52 },
    { lat: 44.085, lng: -103.53 },
    { lat: 44.08, lng: -103.54 },
    { lat: 44.075, lng: -103.55 },
  ], { onRoute: false });
  check(off.events.some((e) => e.type === 'autoskip' && e.id === 'diner'), 'off-route pull-away auto-skips');
  check(navTarget(off.nav, wps).id === 'rush', 'auto-skip advances the target');
  const undone = navRestore(off.nav, 'diner');
  check(navTarget(undone, wps).id === 'diner' && undone.pinned === 'diner', 'UNDO restores and pins');
}

// 5+6. Go next is durable; a pinned destination can NEVER be auto-skipped (the Rushmore report).
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  nav = navGoNext(nav, wps, 'rush'); // skip cabin + diner, pin Rushmore
  check(navTarget(nav, wps).id === 'rush' && nav.skipped.has('cabin') && nav.skipped.has('diner'),
    'Go next skips everything before the chosen stop');
  // ride a shape that looks exactly like "pulling away" — off route, 5 growing fixes
  const r = feed(nav, [
    { lat: 44.055, lng: -103.455 },
    { lat: 44.06, lng: -103.47 },
    { lat: 44.07, lng: -103.49 },
    { lat: 44.08, lng: -103.51 },
    { lat: 44.09, lng: -103.53 },
  ], { onRoute: false });
  check(!r.events.some((e) => e.type === 'autoskip'), 'pinned destination survives a pull-away shape');
  check(navTarget(r.nav, wps).id === 'rush', 'Mount Rushmore stays the destination');
  // arrival releases the pin
  const arr = navFix(r.nav, wps, { lat: 44.05, lng: -103.45 });
  check(arr.nav.visited.has('rush') && arr.nav.pinned === null, 'arrival releases the pin');
  check(navTarget(arr.nav, wps).id === 'lodge', 'then the lodge is next');
}

// 7. Loop day brushing a LATER stop early: it must not latch.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  // bike physically at RUSHMORE's pin while the target is still the cabin
  const r = navFix(nav, wps, { lat: 44.05, lng: -103.45 });
  check(!r.nav.visited.has('rush'), 'a later stop the route brushes early does not latch');
  check(navTarget(r.nav, wps).id === 'cabin', 'target unchanged');
}

// 8. Final stop: never auto-skipped, never latched by proximity, not skippable.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s', 'cabin', 'diner', 'rush']);
  const r = feed(nav, [
    { lat: 44.005, lng: -103.405 },
    { lat: 44.02, lng: -103.42 },
    { lat: 44.04, lng: -103.44 },
    { lat: 44.06, lng: -103.46 },
    { lat: 44.08, lng: -103.48 },
  ], { onRoute: false });
  check(!r.events.length && navTarget(r.nav, wps).id === 'lodge', 'final stop immune to pass-by and latch');
  check(navSkip(nav, wps, 'lodge') === nav, 'final stop is not skippable');
}

// 9. Restore a VISITED stop behind → natural target again, pinned.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s', 'cabin', 'diner']);
  nav = navRestore(nav, 'diner');
  check(navTarget(nav, wps).id === 'diner' && nav.pinned === 'diner', 'restore-behind retargets and pins');
  check(navRemaining(nav, wps).map((w) => w.id).join(',') === 'diner,rush,lodge', 'remaining reads diner → rush → lodge');
}

// 10. Plan edits mid-ride: syncNav prunes facts of removed ids, keeps the rest.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  nav = navGoNext(nav, wps, 'rush');
  const shrunk = wps.filter((w) => w.id !== 'rush');
  const synced = syncNav(nav, shrunk);
  check(synced.pinned === null && !synced.skipped.has('rush'), 'removed pinned stop prunes cleanly');
  check(navTarget(synced, shrunk).id === 'lodge', 'target falls through to the next real stop');
  const added = [...wps.slice(0, 3), { id: 'gas', name: 'Maverik', lat: 44.08, lng: -103.47 }, ...wps.slice(3)];
  check(syncNav(nav, added) === nav, 'adding a stop keeps facts identical (no object churn)');
  check(navTarget(nav, added).id === 'gas' || navTarget(nav, added).id === 'rush',
    'new stop participates by order');
}

// 11. Late start mid-route.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s', 'cabin']);
  check(navTarget(nav, wps).id === 'diner', 'late start aims at the first stop ahead');
}

// 12. Everything ahead skipped → the final stop stands.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  nav = navSkip(nav, wps, 'cabin');
  nav = navSkip(nav, wps, 'diner');
  nav = navSkip(nav, wps, 'rush');
  check(navTarget(nav, wps).id === 'lodge' && navRemaining(nav, wps).length === 1, 'final stop always stands');
}

// 13. On-route passage: a stop whose pin is off the road (never inside the
// arrival ring) resolves as VISITED when the bike's along-route position is
// past it — and the winding-approach case can't fake it (passedTargetId null).
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  const r = navFix(nav, wps, { lat: 44.10, lng: -103.58 }, { onRoute: true, passedTargetId: 'cabin' });
  check(r.nav.visited.has('cabin') && navTarget(r.nav, wps).id === 'diner',
    'along-route passage resolves an unreachable pin as visited');
  check(r.events.some((e) => e.type === 'arrive' && e.id === 'cabin'), 'passage reads as arrival, not a skip');
  // stale passage naming a stop that is no longer the target must not apply
  const stale = navFix(r.nav, wps, { lat: 44.10, lng: -103.57 }, { onRoute: true, passedTargetId: 'cabin' });
  check(!stale.nav.visited.has('diner') && navTarget(stale.nav, wps).id === 'diner',
    'stale passage id is ignored');
  // passage may never resolve the FINAL stop
  let end = createNav();
  end = navInitVisited(end, wps, ['s', 'cabin', 'diner', 'rush']);
  const fin = navFix(end, wps, { lat: 44.02, lng: -103.42 }, { onRoute: true, passedTargetId: 'lodge' });
  check(!fin.nav.visited.has('lodge'), 'passage never resolves the final stop');
}

// 14. Go next while standing AT the stop (the Rushmore 4-mile-loop report):
// declared as arrival + everything-before-behind, aims onward — never a
// routing request to a pin you're on top of.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  const r = navArriveAt(navGoNext(nav, wps, 'diner'), wps, 'diner');
  check(r.visited.has('diner') && r.skipped.has('cabin') && r.pinned === null,
    'at-stop Go next: reached + prior stops behind, no dangling pin');
  check(navTarget(r, wps).id === 'rush', 'nav aims onward, not at the stop under the bike');
  check(navArriveAt(nav, wps, 'lodge') === nav, 'arrival declaration never applies to the final stop');
}

// Identity discipline: an uneventful fix returns the SAME nav object.
{
  let nav = createNav();
  nav = navInitVisited(nav, wps, ['s']);
  const r1 = navFix(nav, wps, { lat: 44.05, lng: -103.60 }, { onRoute: true });
  const r2 = navFix(r1.nav, wps, { lat: 44.055, lng: -103.60 }, { onRoute: true });
  check(r2.nav === r1.nav || r2.nav.visited === r1.nav.visited, 'quiet fixes do not churn state identity');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

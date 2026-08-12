// Ride-nav destination engine — the single source of truth for WHERE
// navigation is taking the rider. Pure and deterministic: no clock, no GPS
// API, no map state. The component feeds it facts (position, whether the bike
// is on the active route) and declarations (skip / restore / go next), and
// reads back the target and remaining stop list every render.
//
// Why it was rebuilt (Aug 12, 2026): the previous machinery derived progress
// from max(latched index, geometric projection). The projection BREATHES — it
// rewinds when a road doubles back (leaving a stop by its arrival road) and
// its flips retargeted nav mid-ride — and every consumer that mixed it into
// targeting inherited a resurrection bug: stops the rider had left came back
// as destinations, explicit "Go next" declarations dissolved, and the
// auto-skip detector fired on the winding APPROACH to a destination
// (straight-line distance to Mount Rushmore grows on Hwy 244's switchbacks
// while the road is taking you there). This engine keeps only FACTS:
//
//   visited — stops the bike physically reached, or that were behind it when
//             the session started (late-start init), or behind an explicit
//             "Go next" declaration
//   skipped — stops the rider declared they are not visiting (restorable)
//   pinned  — the stop the rider EXPLICITLY aimed nav at (Go next / Restore):
//             exempt from auto-skip until arrival or an explicit Skip —
//             a chosen destination can never be silently deleted
//   pass    — the pass-by tracker for the current target only
//
// The target is always: the first waypoint in day order that is neither
// visited nor skipped. No index arithmetic, no projection. The projection
// lives on upstream for DISPLAY (plan delta, mileage readouts) — never here.
//
// Edge cases this design covers (each has a test in ride-nav-test):
//  1. Leaving a stop by its arrival road (projection rewind) — no projection,
//     no rewind: a visited stop stays visited, forever.
//  2. Parked ON a stop that is not the current target — proximity latches any
//     stop ordered at-or-before the target, so it can never resurrect.
//  3. Winding approach (distance to target increasing while ON the route) —
//     auto-skip is suppressed while the bike rides the active route: the
//     road's shape is not a change of intent.
//  4. A genuinely passed-by stop (off its route, pulling away) — auto-skips
//     after 3 increasing fixes past the closest approach, undoable.
//  5. "Go next" — an order-based declaration: everything before the chosen
//     stop is marked behind/skipped in facts; no GPS behavior can undo it.
//  6. A pinned (explicitly chosen) stop is NEVER auto-skipped.
//  7. Loop days that brush a LATER stop early — only stops ordered
//     at-or-before the current target may proximity-latch.
//  8. The day's final stop — never latched, never auto-skipped, never
//     skippable: the end of the day is owned by the arrival state.
//  9. Restore — of a skipped stop ahead or a visited stop behind: its facts
//     clear, day order makes it the target naturally, and the pin marks it
//     rider-chosen.
// 10. Plan edits mid-ride (added stop, sync, Copilot) — facts are keyed by
//     waypoint id; syncNav prunes ids that left the plan.
// 11. Late start — the caller walks the routed line once and hands over the
//     ids clearly behind the bike (initVisited).
// 12. Everything ahead skipped — the final stop still stands as the target.

import { haversineMiles } from './tripEngine.js';

// The arrival ring is speed-tiered (field-caught Aug 12, 2026: a flat 0.25 mi
// declared arrival while still riding 200 m out). At riding speed the pin
// must be practically underfoot; once the bike slows to parking pace the ring
// widens to venue scale — POI pins sit at the building while bikes stop in a
// lot a couple hundred meters short. Stops whose pin the road never gets this
// close to are resolved by along-route passage (ctx.passedTargetId), which is
// what the wide ring was originally papering over.
export const ARRIVE_MI = 0.09;        // ~480 ft at speed: touched the stop
export const ARRIVE_PARKED_MI = 0.21; // ~1100 ft below parking pace
export const PARK_MPH = 6;
export const arriveRingMi = (speedMph) =>
  (speedMph != null && speedMph > PARK_MPH ? ARRIVE_MI : ARRIVE_PARKED_MI);
export const PASS_NEAR_MI = 1.0;   // came at least this close to count as "approached"
export const PASS_AWAY_MI = 0.35;  // then pulled this far past closest approach

export function createNav() {
  return { visited: new Set(), skipped: new Set(), pinned: null, pass: null };
}

// Facts are keyed by waypoint id — when the plan changes under the ride
// (stop added mid-ride, a sync lands, Copilot applies), ids that left the
// plan take their facts with them.
export function syncNav(nav, waypoints) {
  const ids = new Set(waypoints.map((w) => w.id));
  const visited = new Set([...nav.visited].filter((id) => ids.has(id)));
  const skipped = new Set([...nav.skipped].filter((id) => ids.has(id)));
  const pinned = nav.pinned && ids.has(nav.pinned) ? nav.pinned : null;
  const pass = nav.pass && ids.has(nav.pass.id) ? nav.pass : null;
  if (visited.size === nav.visited.size && skipped.size === nav.skipped.size
    && pinned === nav.pinned && pass === nav.pass) return nav;
  return { visited, skipped, pinned, pass };
}

// The stop navigation aims for: first in day order that is neither visited
// nor skipped. Index 0 is the day's ORIGIN — you leave from it, nav never
// routes to it. The final stop is unskippable and unlatchable by
// construction, so there is always a target while stops remain.
export function navTarget(nav, waypoints) {
  for (let i = 1; i < waypoints.length; i++) {
    const w = waypoints[i];
    if (!nav.visited.has(w.id) && !nav.skipped.has(w.id)) return w;
  }
  return waypoints.length > 1 ? waypoints[waypoints.length - 1] : null;
}

// Everything nav still routes through, in day order (origin excluded).
export function navRemaining(nav, waypoints) {
  const rem = waypoints.filter((w, i) => i > 0 && !nav.visited.has(w.id) && !nav.skipped.has(w.id));
  if (!rem.length && waypoints.length > 1) return [waypoints[waypoints.length - 1]];
  return rem;
}

// One GPS fix.
//   ctx.onRoute — the bike is riding the active routed line: the auto-skip
//     detector stands down (edge case 3 — a winding road's shape is not a
//     change of intent).
//   ctx.passedTargetId — the caller measured, ALONG the active route, that
//     the bike is past the route's closest point to this target. That is
//     arrival by passage: an off-road pin can keep ARRIVE_MI out of reach
//     forever, and the along-route measure is monotonic as you ride, so a
//     switchback approach can never fake it. Resolves the target as VISITED,
//     silently — the road went by the stop.
// Returns { nav, events } — the same nav object when nothing changed, so a
// React setState can no-op on identity.
export function navFix(nav, waypoints, fix, { onRoute = false, passedTargetId = null } = {}) {
  if (!waypoints.length || !fix) return { nav, events: [] };
  const events = [];
  let visited = nav.visited;
  let skipped = nav.skipped;
  let pinned = nav.pinned;
  let pass = nav.pass;
  const lastIdx = waypoints.length - 1;

  // 1. Proximity latch — any stop ordered at-or-before the target that the
  // bike is physically on becomes visited. Never the final stop.
  const ring = arriveRingMi(fix.speedMph);
  const before = navTarget(nav, waypoints);
  const beforeIdx = waypoints.findIndex((w) => w.id === before?.id);
  for (let i = 0; i <= Math.min(beforeIdx, lastIdx - 1); i++) {
    const w = waypoints[i];
    if (visited.has(w.id) || skipped.has(w.id)) continue;
    if (haversineMiles(fix, w) < ring) {
      if (visited === nav.visited) visited = new Set(visited);
      visited.add(w.id);
      if (pinned === w.id) pinned = null;
      if (pass?.id === w.id) pass = null;
      events.push({ type: 'arrive', id: w.id, name: w.name });
    }
  }

  // 2. On-route passage: the road has gone past the target (see ctx docs).
  // Applies only if the passage measurement still names the current target —
  // the proximity latch above may have advanced it this same fix.
  let probe = { visited, skipped, pinned, pass };
  let target = navTarget(probe, waypoints);
  if (onRoute && passedTargetId && target?.id === passedTargetId
    && waypoints.findIndex((w) => w.id === target.id) < lastIdx) {
    if (visited === nav.visited) visited = new Set(visited);
    visited.add(target.id);
    if (pinned === target.id) pinned = null;
    if (pass?.id === target.id) pass = null;
    events.push({ type: 'arrive', id: target.id, name: target.name });
  }

  // 3. Re-derive the target, then track the pass-by state for it alone. A
  // target change only ever means the old one RESOLVED (visited or skipped)
  // — there is no silent projection hand-off to honor.
  probe = { visited, skipped, pinned, pass };
  target = navTarget(probe, waypoints);
  const targetIdx = waypoints.findIndex((w) => w.id === target?.id);
  if (target && targetIdx < lastIdx) {
    const d = haversineMiles(fix, target);
    if (!pass || pass.id !== target.id) {
      pass = { id: target.id, min: d, lastD: d, away: 0 };
    } else {
      pass = {
        id: pass.id,
        min: Math.min(pass.min, d),
        lastD: d,
        away: d > pass.lastD + 0.01 ? pass.away + 1 : 0,
      };
    }
    // 4. Auto-skip: approached, now pulling away for several fixes, and NOT
    // riding the route that leads there, and NOT the rider's explicit pick.
    if (!onRoute && pinned !== target.id
      && pass.min <= PASS_NEAR_MI && pass.min > ARRIVE_MI
      && d >= pass.min + PASS_AWAY_MI && pass.away >= 3) {
      if (skipped === nav.skipped) skipped = new Set(skipped);
      skipped.add(target.id);
      pass = null;
      events.push({ type: 'autoskip', id: target.id, name: target.name });
    }
  } else if (pass && pass.id !== target?.id) {
    pass = null;
  }

  if (visited === nav.visited && skipped === nav.skipped
    && pinned === nav.pinned && pass === nav.pass) return { nav, events };
  return { nav: { visited, skipped, pinned, pass }, events };
}

// "Go next" from the ride sheet: aim nav straight at this stop. Everything
// ordered before it that the bike hasn't visited is declared skipped — a
// statement of intent that no GPS behavior can dissolve. The chosen stop is
// pinned: exempt from auto-skip until reached or explicitly skipped.
export function navGoNext(nav, waypoints, id) {
  const k = waypoints.findIndex((w) => w.id === id);
  if (k < 0) return nav;
  const skipped = new Set(nav.skipped);
  for (let i = 0; i < k; i++) {
    const w = waypoints[i];
    if (!nav.visited.has(w.id)) skipped.add(w.id);
  }
  skipped.delete(id);
  const visited = new Set(nav.visited);
  visited.delete(id); // "take me there" beats a stale arrival latch
  return { visited, skipped, pinned: id, pass: null };
}

// Explicit skip. The final stop is the day's destination — not skippable.
export function navSkip(nav, waypoints, id) {
  if (waypoints[waypoints.length - 1]?.id === id) return nav;
  const skipped = new Set(nav.skipped);
  skipped.add(id);
  return {
    visited: nav.visited,
    skipped,
    pinned: nav.pinned === id ? null : nav.pinned,
    pass: nav.pass?.id === id ? null : nav.pass,
  };
}

// Restore a stop — skipped ahead or already-visited behind, same gesture:
// clear its facts and day order makes it the target again; pin it as the
// rider's explicit choice so nothing auto-drops it on the way back.
export function navRestore(nav, id) {
  const skipped = new Set(nav.skipped);
  const visited = new Set(nav.visited);
  skipped.delete(id);
  visited.delete(id);
  return { visited, skipped, pinned: id, pass: null };
}

// The rider declared arrival at a stop the bike is standing at ("Go next"
// inside the arrival ring): a routing request to a pin you are on top of
// yields a legal-loop tour of the parking lot's one-ways (field-caught at
// Mount Rushmore — 4 road-miles to a stop 550 feet away). The final stop is
// excluded: the arrival state owns the end of the day.
export function navArriveAt(nav, waypoints, id) {
  if (waypoints[waypoints.length - 1]?.id === id) return nav;
  if (!waypoints.some((w) => w.id === id)) return nav;
  const visited = new Set(nav.visited);
  visited.add(id);
  const skipped = new Set(nav.skipped);
  skipped.delete(id);
  return {
    visited,
    skipped,
    pinned: nav.pinned === id ? null : nav.pinned,
    pass: nav.pass?.id === id ? null : nav.pass,
  };
}

// Late-start init: the ids the routed-line walk found clearly behind the
// bike when the session opened.
export function navInitVisited(nav, waypoints, ids) {
  const lastId = waypoints[waypoints.length - 1]?.id;
  const visited = new Set(nav.visited);
  for (const id of ids) if (id !== lastId) visited.add(id);
  return { visited, skipped: nav.skipped, pinned: nav.pinned, pass: nav.pass };
}

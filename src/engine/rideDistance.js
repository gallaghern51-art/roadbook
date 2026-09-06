// How far is it, really.
//
// Ride Mode's mileages — distance to the next turn, miles left in this leg,
// miles left in the day — were all measured by projecting the bike onto the
// MANEUVER chain: the list of turn points, with a straight chord drawn between
// consecutive ones. That chain is not the road. Between two maneuvers on an
// interstate there is exactly one chord, and it can be a hundred miles long
// while the road it stands for bends thirty miles off it.
//
// The consequence is a readout that runs fast on the stretches aligned with
// the chord and STOPS on the stretches that cross it. Field report, Aug 16
// 2026, riding I-90 Bozeman → Missoula: "it shows me it's ninety three miles
// away, but as I'm watching the mile markers, I've been stuck on ninety three
// miles for about two to three miles." The same ride's screenshots show the
// other half of it — 193 mi at 9:20 and 161 mi at 9:42, which is 33 miles of
// readout in 22 minutes, an indicated 90 mph on a road being ridden at 70.
// The bike was riding the long northward swing through Deer Lodge, which runs
// almost square across the Bozeman→Missoula chord: real miles, no chord
// progress. Nothing was wrong with the GPS or the route. The ruler was wrong.
//
// So mileages are measured along the ROUTED GEOMETRY instead — the dense chain
// the bike actually rides, which Ride Mode already holds (`geomInfo`) and
// already trusts for the traveled/ahead split and for deciding a stop has been
// passed. Every maneuver gets an along-position on that chain, once, and after
// that a distance is a subtraction. The maneuver chain keeps the jobs it is
// good at: which turn is next, what it says, which lane.
//
// Times still come from the steps (only they carry durations), but the current
// step's remainder is prorated by real distance rather than by chord fraction.

import { projectOnChainDirected } from './tripEngine.js';

// A maneuver point should sit within metres of the geometry — both come out of
// the same routing call. The gate is loose enough for an `arrive` step, which
// sits at the STOP and can be a parking lot off the road, and tight enough
// that a stale step list can't quietly pin itself to the wrong road.
const ON_ROUTE_MI = 1.0;

/**
 * Each step's position along the routed geometry, in ground miles.
 *
 * Forward-only: step n is looked for at or past step n−1's position, so a day
 * that rides the same pavement twice (an out-and-back, a loop past the
 * lodging) puts each maneuver on the pass that actually reaches it instead of
 * on whichever copy happens to be nearest. A maneuver that can't be found on
 * the chain inherits the running position plus its predecessor's own step
 * distance — dead reckoning keeps the ladder monotonic rather than collapsing
 * it to zero.
 *
 * @param {object[]} steps  maneuvers, each {lat, lng, dist}
 * @param {{chain: {lat:number,lng:number}[], cum: number[]}} geom
 * @returns {number[]|null} along-miles per step, non-decreasing
 */
export function stepAlongs(steps, geom) {
  const chain = geom?.chain;
  const cum = geom?.cum;
  if (!steps?.length || !chain || chain.length < 2 || !cum) return null;
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const out = new Array(steps.length);
  let after = 0;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    let at = null;
    if (Number.isFinite(st?.lat) && Number.isFinite(st?.lng)) {
      const p = projectOnChainDirected(chain, st, { cum, afterMi: after });
      if (p && p.off <= ON_ROUTE_MI) at = p.along;
    }
    if (at == null) at = after + (Number.isFinite(steps[i - 1]?.dist) ? steps[i - 1].dist : 0);
    out[i] = Math.min(total, Math.max(after, at));
    after = out[i];
  }
  return out;
}

/**
 * The nav readout, measured on the geometry.
 *
 * Same shape `locateOnSteps` returns, so it drops in wherever that was read:
 * which maneuver is next and what follows it, the distance to it, what is left
 * of this leg (to the next `arrive`) and of the whole route.
 *
 * @param {object[]} steps
 * @param {number[]} alongs  from stepAlongs, same length as steps
 * @param {number} along     the bike's along-position in ground miles
 * @param {number} total     the route's length in ground miles
 * @param {number} off       the bike's distance from the line (passed through)
 */
export function navAlongRoute(steps, alongs, along, total, off = 0) {
  if (!steps?.length || !alongs?.length || !Number.isFinite(along)) return null;
  const last = steps.length - 1;
  // The current step is the last one the bike is at or past. A tie at a
  // maneuver point resolves forward — you are on the new step the moment you
  // reach it, which is also what stops the turn card flickering between two
  // instructions while the bike sits on the junction.
  let i = 0;
  while (i < last - 1 && alongs[i + 1] <= along) i += 1;
  const nextAt = alongs[Math.min(i + 1, last)];
  const toNext = Math.max(0, nextAt - along);

  // the arrive step that closes this leg; failing that, the end of the route
  let legEnd = null;
  for (let j = i + 1; j <= last; j++) {
    if (steps[j].type === 'arrive') { legEnd = j; break; }
  }
  const legMi = Math.max(0, (legEnd != null ? alongs[legEnd] : total) - along);
  const remMi = Math.max(0, total - along);

  // Durations: whole steps ahead, plus the part of the current step still to
  // ride — prorated by DISTANCE covered, which is the whole point of this file.
  const span = alongs[Math.min(i + 1, last)] - alongs[i];
  const leftOfCur = span > 0 ? Math.max(0, Math.min(1, toNext / span)) : 0;
  let remSec = leftOfCur * (steps[i].sec ?? 0);
  let legSec = remSec;
  for (let j = i + 1; j <= last; j++) {
    const sec = steps[j].sec ?? 0;
    if (legEnd == null || j < legEnd) legSec += sec;
    remSec += sec;
  }
  const legStep = legEnd != null ? steps[legEnd] : steps[last];
  return {
    next: steps[i + 1] ?? steps[last], after: steps[i + 2] ?? null, idx: i + 1,
    toNext, off,
    remMi, remMin: remSec / 60,
    legMi, legMin: legSec / 60, legStop: legStep?.stop ?? null,
  };
}

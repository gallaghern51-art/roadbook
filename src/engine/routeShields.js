// Where to paint highway shields along a routed day.
//
// The route line is drawn with a glow, a casing and a 3px core, and on the
// satellite basemap it lands right on top of the shields the tiles already
// carry — so the one thing a rider wants at a glance ("am I on I-90 or did I
// come off it?") is the thing the plan covers up. Owner request, Aug 15 2026:
// put some road signs BACK on the map.
//
// "Some" is the whole design problem. A day's turn list names a road on every
// maneuver, and painting each one gives you a picket fence of shields along
// the line, which is worse than none. So this reduces the step list to RUNS —
// contiguous stretches carrying the same route number — and marks each run
// once in its middle, repeating only when a run is long enough that a rider
// looking at any part of the line would otherwise see nothing.
//
// The two maps want different answers out of that. A PLAN overview frames
// tens of miles, so a shield every thirty is plenty. A NAV camera frames
// about three quarters of a mile, where the same spacing means a rider goes
// half an hour without ever seeing one — so Ride passes `aheadMi`, the bike's
// along-route position, and gets a sparse ladder of candidates on the road
// IN FRONT of it. Ride then draws at most ONE of them (the `max` prop on
// RouteShields). That cap is the whole restraint: shields were tried in Ride
// unbounded first and pulled straight back out ("take road markers off ride
// mode"), and the second ask was for them back "not overbearing on the view".
// One small sign on the road ahead, sliding past as you ride it, is a sign.
// Three at once is wallpaper on a screen a rider glances at at 70 mph.
//
// Short runs are dropped entirely: a quarter mile of state route between two
// interstate ramps is a routing detail, not something to sign.

import { stepRoadShields } from './roads.js';
import { haversineMiles } from './tripEngine.js';

export const MIN_RUN_MI = 1.2;   // below this it is a ramp or a town block
export const REPEAT_MI = 30;     // a long interstate gets a shield every ~30 mi
export const MAX_SHIELDS = 24;   // a whole-day ceiling on markers; what is
                                 // actually DRAWN is thinned again in screen
                                 // space, where the zoom is known

// The nav ladder: candidates from the bike forward, on a fixed grid so their
// ids hold steady as the bike moves and the markers slide instead of being
// torn down and rebuilt.
//
// The grid spacing IS the frequency a rider experiences — one sign comes round
// every AHEAD_REPEAT_MI of riding. It shipped at half a mile, and the owner
// rode it (Aug 16 2026): "the road signs are appearing too frequently, I want
// them at one third to one fourth the frequency." Two miles is the quarter, and
// it changes the character of the thing: at half a mile there was always a
// shield somewhere on screen, which is wallpaper. At two, the road you are on
// says so every few minutes and the screen is otherwise clear.
//
// The span is the other half of it, and it is deliberately shorter than the
// grid: a sign is a candidate only for the last mile of its approach, so it
// slides in, passes, and the screen is empty again. Sim-measured on the built
// app, a sign is up for about a third of the fixes on a highway stretch; at
// the half-mile grid with a 1.5-mi span there was one up on nearly every one.
// 0.9 mi is ~50 seconds of warning at an interstate cruise.
export const AHEAD_SPAN_MI = 0.9;
export const AHEAD_REPEAT_MI = 2;
export const AHEAD_LEAD_MI = 0.2;   // never sign the ground under the puck
// A road CHANGE is exempt from the grid. "You are on US-14 now" is the one
// thing this ladder exists to say, and a two-mile grid could hold it back for
// two miles; it gets signed just past the change, as soon as it is in reach.
export const AHEAD_CHANGE_MI = 0.25;

/**
 * Contiguous stretches of one route number, measured along the step chain.
 *
 * A step with no road at all (an unnamed maneuver, or a Google instruction
 * that says only "Continue straight") EXTENDS the current run rather than
 * breaking it — you are still on the same road through it, and treating
 * silence as a road change fragments long highways into unsignable slivers.
 *
 * @param {{dist:number, road?:string|null, instr?:string}[]} steps
 * @returns {{key:string, shields:object[], startMi:number, endMi:number, miles:number}[]}
 */
export function roadRuns(steps) {
  const runs = [];
  let mi = 0;
  for (const st of steps ?? []) {
    const shields = stepRoadShields(st);
    const len = Number.isFinite(st?.dist) ? st.dist : 0;
    if (shields.length) {
      const key = shields.map((s) => s.key).join('+');
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.endMi = mi + len;
      else runs.push({ key, shields, startMi: mi, endMi: mi + len });
    } else if (runs.length) {
      runs[runs.length - 1].endMi = mi + len;
    }
    mi += len;
  }
  return runs.map((r) => ({ ...r, miles: r.endMi - r.startMi }));
}

// A chain position at `mi` miles along, interpolated between vertices.
function pointAtMile(chain, cum, mi) {
  const total = cum[cum.length - 1];
  const t = Math.max(0, Math.min(total, mi));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= t) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const f = seg > 0 ? (t - cum[lo]) / seg : 0;
  const a = chain[lo];
  const b = chain[hi];
  return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
}

/**
 * Shield positions for one day.
 *
 * @param {object[]} steps    routed maneuvers (need `dist` + `road`/`instr`)
 * @param {{lat:number,lng:number}[]} chain  the day's routed geometry
 * @param {{cum?:number[], aheadMi?:number|null}} opts  `cum` when the caller
 *   already has cumulative miles for the chain; `aheadMi` is the bike's
 *   along-route position in GEOMETRY miles (the units every caller measures
 *   the bike in), which adds the nav ladder in front of it
 * @returns {{id:string, key:string, shields:object[], mi:number, first:boolean,
 *   lat:number, lng:number}[]}
 */
export function shieldPlacements(steps, chain, {
  cum = null, minRunMi = MIN_RUN_MI, repeatMi = REPEAT_MI, max = MAX_SHIELDS,
  aheadMi = null, aheadSpanMi = AHEAD_SPAN_MI, aheadRepeatMi = AHEAD_REPEAT_MI,
  aheadLeadMi = AHEAD_LEAD_MI, aheadChangeMi = AHEAD_CHANGE_MI,
} = {}) {
  if (!steps?.length || !chain || chain.length < 2) return [];
  let c = cum;
  if (!c) {
    c = [0];
    for (let i = 1; i < chain.length; i++) c.push(c[i - 1] + haversineMiles(chain[i - 1], chain[i]));
  }
  const geomTotal = c[c.length - 1];
  if (!(geomTotal > 0)) return [];

  const runs = roadRuns(steps).filter((r) => r.miles >= minRunMi);
  if (!runs.length) return [];

  // Steps and geometry describe the same route, so their totals agree to
  // rounding — but the geometry is stored at 5 decimals and the step chain
  // cuts corners, so scale rather than assume.
  const stepTotal = steps.reduce((a, s) => a + (Number.isFinite(s?.dist) ? s.dist : 0), 0);
  const scale = stepTotal > 0 ? geomTotal / stepTotal : 1;
  const ahead = Number.isFinite(aheadMi) ? aheadMi / scale : null;

  const seen = new Set();
  const out = [];
  const put = (r, mi, first) => {
    const id = `${r.key}@${mi.toFixed(2)}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id, key: r.key, shields: r.shields, runMi: r.miles, first, mi,
      ...pointAtMile(chain, c, mi * scale),
    });
  };

  for (const r of runs) {
    // A nav camera frames about a mile, so the plan map's every-30-miles
    // repeats are never the sign a rider sees — but they ARE a second source
    // of candidates competing for Ride's single slot, and one parked mid-run
    // put a shield back on screen in the middle of a stretch the ladder had
    // deliberately left clear. When there is a bike, the ladder is the whole
    // answer.
    const n = ahead != null ? 0 : Math.max(1, Math.ceil(r.miles / repeatMi));
    for (let k = 0; k < n; k++) {
      // The FIRST shield of a run is the one that carries information — it is
      // where the road number changes. Marked so the screen-space cull seats
      // it before it starts seating repeats of a road already named; without
      // that a day's long interstate eats every slot and the road it turns
      // onto goes unsigned for a hundred miles.
      put(r, r.startMi + (r.miles * (k + 0.5)) / n, k === 0);
    }
    if (ahead != null) {
      // FORWARD only, and never right under the puck. A sign behind the bike
      // is one it has already ridden past, and with Ride drawing a single
      // shield either would take the slot from the road actually coming up.
      // The upper bound is EXCLUSIVE of the run's end: at a road change the
      // old number and the new one both own that exact mile, and signing the
      // road you are leaving while you are joining the next one is the one
      // reading a rider would call wrong.
      const lo = Math.max(r.startMi, ahead + aheadLeadMi);
      const hi = Math.min(r.endMi, ahead + aheadSpanMi);
      // The road change itself, off-grid and flagged `first` so the screen-space
      // cull seats it ahead of any repeat competing for Ride's single slot.
      const change = r.startMi + Math.min(aheadChangeMi, r.miles / 4);
      if (change > ahead + aheadLeadMi && change <= ahead + aheadSpanMi) put(r, change, true);
      for (let m = Math.ceil(lo / aheadRepeatMi) * aheadRepeatMi; m <= hi; m += aheadRepeatMi) {
        if (m < r.endMi) put(r, m, false);
      }
    }
  }

  // Over the ceiling: road changes first, then the longest runs — a rider
  // needs "you are on I-90 for the next 90 miles" before they need a two-mile
  // connector named.
  if (out.length > max) {
    const keep = new Set(
      [...out].sort((a, b) => (b.first ? 1 : 0) - (a.first ? 1 : 0) || b.runMi - a.runMi)
        .slice(0, max).map((p) => p.id)
    );
    return out.filter((p) => keep.has(p.id)).sort((a, b) => a.mi - b.mi);
  }
  return out.sort((a, b) => a.mi - b.mi);
}

// Where to paint highway shields along a routed day.
//
// The route line is drawn with a glow, a casing and a 3px core, and on the
// satellite basemap it lands right on top of the shields the tiles already
// carry — so the one thing a rider wants at a glance ("am I on I-90 or did I
// come off it?") is the thing the plan covers up. Owner request, Aug 15 2026:
// put some road signs BACK on the map. PLAN ONLY — shields were tried in Ride
// Mode too and taken back out at the owner's call the same day; a nav HUD
// wants the road name in one place (the turn card), not scattered across the
// map a rider is glancing at.
//
// "Some" is the whole design problem. A day's turn list names a road on every
// maneuver, and painting each one gives you a picket fence of shields along
// the line, which is worse than none. So this reduces the step list to RUNS —
// contiguous stretches carrying the same route number — and marks each run
// once in its middle, repeating only when a run is long enough that a rider
// looking at any part of the line would otherwise see nothing.
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
 * @param {{cum?:number[]}} opts  `cum` when the caller already has cumulative
 *   miles for the chain
 * @returns {{id:string, key:string, shields:object[], mi:number, first:boolean,
 *   lat:number, lng:number}[]}
 */
export function shieldPlacements(steps, chain, {
  cum = null, minRunMi = MIN_RUN_MI, repeatMi = REPEAT_MI, max = MAX_SHIELDS,
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

  const out = [];
  for (const r of runs) {
    const n = Math.max(1, Math.ceil(r.miles / repeatMi));
    for (let k = 0; k < n; k++) {
      const mi = r.startMi + (r.miles * (k + 0.5)) / n;
      out.push({
        id: `${r.key}@${mi.toFixed(2)}`,
        key: r.key,
        shields: r.shields,
        runMi: r.miles,
        // The FIRST shield of a run is the one that carries information — it
        // is where the road number changes. Marked so the screen-space cull
        // seats it before it starts seating repeats of a road already named;
        // without that a day's long interstate eats every slot and the road
        // it turns onto goes unsigned for a hundred miles.
        first: k === 0,
        mi,
        ...pointAtMile(chain, c, mi * scale),
      });
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

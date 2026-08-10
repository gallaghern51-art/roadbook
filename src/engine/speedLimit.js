// Posted speed limits for the road under the bike, from OpenStreetMap maxspeed
// tags via the Overpass API. Free tier like Nominatim: keep request volume low.
// One small query (~60 m radius, ways with a maxspeed only) at most every 12 s,
// and none at all while the bike stays on the way it already matched — a long
// highway way keeps the sign lit for miles on a single fetch. Coverage is
// honest: plenty of rural two-lane carries no tag, and the sign simply hides.

import { projectOnChain } from './tripEngine.js';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const QUERY_GAP_MS = 12_000;
const ERR_BACKOFF_MS = 60_000;
const NEAR_MI = 0.035; // ~55 m: on this road, GPS scatter included
const ALIGN_DEG = 50;  // heading within this of the way's axis (either direction)

// "75 mph" → 75 · "80" → km/h → 49.7 · "none"/garbage → null
export function parseMaxspeed(tag) {
  const m = /([\d.]+)\s*(mph)?/i.exec(String(tag ?? ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2] ? n : n * 0.621371;
}

const segBearing = (a, b) => {
  const d = (Math.atan2(
    (b.lng - a.lng) * Math.cos((a.lat * Math.PI) / 180),
    b.lat - a.lat
  ) * 180) / Math.PI;
  return (d + 360) % 360;
};

// A two-way road is drawn in one arbitrary direction, so travel along OR
// against the way both count as "on it"; a crossing road (~90° off) does not.
const aligned = (heading, bearing) => {
  const diff = Math.abs(((heading - bearing + 540) % 360) - 180); // 0 = opposite, 180 = same
  return diff >= 180 - ALIGN_DEG || diff <= ALIGN_DEG;
};

function matchWay(ways, fix) {
  let best = null;
  for (const w of ways) {
    const p = projectOnChain(w.chain, fix);
    if (!p || p.off > NEAR_MI) continue;
    if (fix.heading != null && (fix.speedMph == null || fix.speedMph > 8)) {
      const a = w.chain[p.i];
      const b = w.chain[p.i + 1];
      if (a && b && !aligned(fix.heading, segBearing(a, b))) continue;
    }
    if (!best || p.off < best.off) best = { off: p.off, mph: w.mph, ref: w.ref };
  }
  return best ? { mph: best.mph, ref: best.ref } : null;
}

// Tracker held for one ride session. update(fix) resolves to:
//   {mph, ref}  — new limit to show
//   null        — limit no longer known (hide the sign)
//   undefined   — nothing new (throttled, unchanged, or errored)
export function speedLimitTracker() {
  let ways = [];
  let current = null;
  let lastFetch = 0;
  let backoffUntil = 0;
  let inflight = false;

  const settle = (next) => {
    const changed = (next?.mph ?? null) !== (current?.mph ?? null) || (next?.ref ?? null) !== (current?.ref ?? null);
    current = next;
    return changed ? (next ?? null) : undefined;
  };

  return {
    async update(fix) {
      if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return undefined;
      // still on a fetched way → no network at all
      const here = matchWay(ways, fix);
      if (here) return settle(here);
      const now = Date.now();
      if (inflight || now < backoffUntil || now - lastFetch < QUERY_GAP_MS) return undefined;
      inflight = true;
      lastFetch = now;
      try {
        const q = `[out:json][timeout:6];way(around:60,${fix.lat.toFixed(5)},${fix.lng.toFixed(5)})["highway"]["maxspeed"];out tags geom 12;`;
        const res = await fetch(OVERPASS, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
        });
        if (!res.ok) throw new Error(`overpass ${res.status}`);
        const json = await res.json();
        ways = (json.elements ?? [])
          .map((el) => ({
            mph: parseMaxspeed(el.tags?.maxspeed),
            ref: el.tags?.ref || el.tags?.name || null,
            chain: (el.geometry ?? []).map((g) => ({ lat: g.lat, lng: g.lon })),
          }))
          .filter((w) => w.mph != null && w.chain.length > 1);
        return settle(matchWay(ways, fix));
      } catch {
        backoffUntil = Date.now() + ERR_BACKOFF_MS;
        return undefined;
      } finally {
        inflight = false;
      }
    },
  };
}

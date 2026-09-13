// Tie every seed stop to a real Google place (owner, Sep 13 2026: "fix the
// sturgis template… destinations are not tied to actual Google places").
//
//   node tools/verify-seed.mjs            # dry run: the report, nothing written
//   node tools/verify-seed.mjs --write    # writes src/data/seedPlaces.js
//   node tools/verify-seed.mjs --trip early-exit [--write]   # the early-exit template → earlyExitPlaces.js
//
// Every waypoint, meal and lodging is looked up by NAME inside a hard
// rectangle around the seed's own coordinate (a bias returns namesakes 500 mi
// away — Mirch Masala, Billings), typed where the class demands it (fuel →
// gas_station, meals → restaurant, hotels → lodging). A hit snaps the stop to
// Google's coordinate and identity; a scenic stop with no listing is marked
// PLACED (a deliberate coordinate, never presented as verified); a business
// with no listing is marked unverified so the rider re-picks it. Airbnbs are
// not Google places: they stay the rider's own booked address.
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { SEED_TRIP } from '../src/data/seedTrip.js';
import { EARLY_EXIT_TRIP } from '../src/data/earlyExitTemplate.js';
import { searchPlacesGoogle } from '../netlify/lib/places-core.mjs';
import { nameOverlap, milesBetween } from '../netlify/lib/verify-places.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const env = Object.fromEntries(readFileSync(`${ROOT}.env.local`, 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)));
const KEY = process.env.GOOGLE_MAPS_API_KEY || env.GOOGLE_MAPS_API_KEY;
if (!KEY) { console.error('GOOGLE_MAPS_API_KEY missing (.env.local)'); process.exit(2); }
const WRITE = process.argv.includes('--write');
const WHICH = process.argv[process.argv.indexOf('--trip') + 1] === 'early-exit' && process.argv.includes('--trip') ? 'early-exit' : 'seed';
const TRIP = WHICH === 'early-exit' ? EARLY_EXIT_TRIP : SEED_TRIP;
const OUT = WHICH === 'early-exit' ? { file: 'src/data/earlyExitPlaces.js', name: 'EARLY_EXIT_PLACES' } : { file: 'src/data/seedPlaces.js', name: 'SEED_PLACES' };

const SCENIC = /\b(pass|falls|overlook|viewpoint|summit|point|lake|reservoir|canyon|monument|memorial|peak|shore|scenic|road|highway|junction|byway|geyser|basin|spring|trail|vista|dam|ridge|mountain|bridge|gap|creek)\b/i;
const TOWN = /^[A-Z][\w'’. ]+, (MT|WY|SD|ID)$/;
// "Maverik — Greybull, WY" → "Maverik Greybull, WY" (Places matches address text
// too); "(breakfast)", clock times and elevations go; "St." → "Saint" so the
// token overlap sees Saint Regis for St. Regis.
const cleanQuery = (name) => String(name).replace(/\(.*?\)/g, '').replace(/\s[—–-]\s/g, ' ').replace(/\b\d{1,2}:\d{2}\s?(AM|PM)?\b/gi, '').replace(/,?\s*[\d,]+\s*ft\b/gi, '').replace(/\bSt\.?\s/g, 'Saint ').replace(/\s+/g, ' ').trim();
// Not a place at all — a choice, a plan, a home: never matched, never flagged.
const PLACEHOLDER = /\bor\b|cookout|grab-and-go|\bquick\b|\bcasual\b|roadside|pick on arrival|airbnb|hotel grab|as booked|fly home|\/|main st\b|entrance booth|park entrance/i;
// Types a scenic stop or a town can never be: the salon or the physio that
// happens to carry the place's name.
const NOT_A_PLACE = /store|health|doctor|physio|beauty|hair|salon|golf|gym|school|real_estate|car_repair|dentist|lawyer|bathroom|toilet|lodging|restaurant|cafe|bar\b|casino|vacation_rental|finance|insurance|rafting|zipline/i;

function classify(w) {
  if (w.kind === 'fuel' || w.fuel === true) return { cls: 'fuel', type: 'gas_station', maxMi: 3 };
  if (TOWN.test(w.name)) return { cls: 'town', type: null, maxMi: 6 };
  if (/airport|\(MSO\)/i.test(w.name)) return { cls: 'airport', type: 'airport', maxMi: 4 };
  // a deliberate coordinate: downtown, the cabin, a junction, a park booth —
  // never a business to look up
  // a start/end named for the rider's own bed (the cabin, the court, the Airbnb) is a deliberate pin too
  if (PLACEHOLDER.test(w.name) || /downtown|cabin|junction|turnoff|pullouts?|tunnel view/i.test(w.name) || ((w.kind === 'start' || w.kind === 'end') && /\b(court|cozy|house|lodge|cabin)\b/i.test(w.name))) return { cls: 'anchor', type: null, maxMi: 3 };
  if (w.kind === 'photo' || SCENIC.test(w.name)) return { cls: 'scenic', type: null, maxMi: 3 };
  return { cls: 'business', type: null, maxMi: 6 }; // 6: a hand-transcribed pin can be a few miles out (Quinn's was 4)
}
const typesOf = (c) => [c.primaryType, ...(c.types ?? [])].filter(Boolean).join(' ');
function pick(rows, { want, near, maxMi, deny = null }) {
  let win = null;
  for (const c of rows) {
    if (c.status && c.status !== 'OPERATIONAL') continue;
    if (deny && deny.test(typesOf(c))) continue;
    const mi = milesBetween(near, c);
    if (!(mi <= maxMi)) continue;
    const cand = { ...c, mi, overlap: nameOverlap(want, c.name) };
    if (!win) { win = cand; continue; }
    const better = Math.round(cand.overlap * 10) - Math.round(win.overlap * 10);
    if (better > 0 || (better === 0 && cand.mi < win.mi)) win = cand;
  }
  return win;
}
async function lookup(name, near, { type, maxMi, generic = null, deny = null, restrict = true }) {
  const run = (q, t) => searchPlacesGoogle(KEY, q, near, { limit: 6, classify: true, enrich: true, type: t, radiusM: Math.round(maxMi * 1609.34), restrict }).catch(() => []);
  const q = cleanQuery(name);
  let hit = q.length >= 2 ? pick(await run(q, type), { want: q, near, maxMi, deny }) : null;
  if (!hit && type) hit = pick(await run(q, null), { want: q, near, maxMi, deny }); // the name without the type filter
  if (!hit && generic) { const g = pick(await run(generic, type), { want: q, near, maxMi, deny }); if (g) hit = { ...g, generic: true }; }
  return hit;
}
const rec = (hit) => ({ placeId: hit.id, googleName: hit.name, address: hit.detail ?? '', lat: hit.lat, lng: hit.lng, types: (hit.types ?? []).slice(0, 3), mi: Number(hit.mi.toFixed(2)), overlap: Number(hit.overlap.toFixed(2)), ...(hit.generic ? { generic: true } : {}) });

const out = { generatedAt: new Date().toISOString().slice(0, 10), waypoints: {}, lodging: {}, meals: {} };
const lines = [];
for (const day of TRIP.days) {
  for (const w of day.waypoints) {
    const spec = classify(w);
    const near = { lat: w.lat, lng: w.lng };
    const deny = spec.cls === 'scenic' || spec.cls === 'town' ? NOT_A_PLACE : null;
    const hit = spec.cls === 'anchor' ? null : await lookup(w.name, near, { type: spec.type, maxMi: spec.maxMi, generic: spec.cls === 'fuel' ? 'gas station' : null, deny });
    const need = spec.cls === 'scenic' || spec.cls === 'town' ? 0.6 : 0.4;
    const townFuel = spec.cls === 'fuel' && TOWN.test(w.name) && hit && /gas_station/.test(typesOf(hit));
    if (hit && (hit.overlap >= need || (hit.generic && spec.cls === 'fuel') || townFuel)) {
      out.waypoints[w.id] = { ...rec(hit), cls: spec.cls, verified: 'google', ...(townFuel || hit.generic ? { rename: `${hit.name} — ${w.name.replace(/^.*?—\s*/, '')}` } : {}) };
      lines.push(`✓ ${day.date} ${w.id} ${spec.cls.padEnd(8)} ${w.name}  →  ${hit.name} (${hit.mi} mi, ${(hit.overlap * 100).toFixed(0)}%${hit.generic ? ', generic' : ''})`);
    } else if (spec.cls === 'scenic' || spec.cls === 'town' || spec.cls === 'anchor') {
      out.waypoints[w.id] = { cls: spec.cls, placed: 'author', ...(hit ? { candidate: rec(hit) } : {}) };
      lines.push(`· ${day.date} ${w.id} ${spec.cls.padEnd(8)} ${w.name}  →  placed (author coordinate)${hit ? ` — nearest: ${hit.name} ${hit.mi} mi ${(hit.overlap * 100).toFixed(0)}%` : ''}`);
    } else {
      out.waypoints[w.id] = { cls: spec.cls, verified: false, ...(hit ? { candidate: rec(hit) } : {}) };
      lines.push(`✗ ${day.date} ${w.id} ${spec.cls.padEnd(8)} ${w.name}  →  NO LISTING${hit ? ` — nearest: ${hit.name} ${hit.mi} mi ${(hit.overlap * 100).toFixed(0)}%` : ''}`);
    }
  }
  const wps = day.waypoints;
  const l = day.lodging;
  if (l?.name && l.status !== 'none' && !/fly home|as booked/i.test(l.name)) {
    if (/airbnb/i.test(l.name)) { out.lodging[day.id ?? day.date] = { placed: 'rider', where: l.where }; lines.push(`· ${day.date} lodging ${l.name} → rider's booked address (Airbnb)`); }
    else {
      const hit = await lookup(l.name, wps[wps.length - 1], { type: 'lodging', maxMi: 8 });
      if (hit && hit.overlap >= 0.4) { out.lodging[day.id ?? day.date] = { ...rec(hit), verified: 'google' }; lines.push(`✓ ${day.date} lodging ${l.name} → ${hit.name} (${hit.mi} mi)`); }
      else { out.lodging[day.id ?? day.date] = { verified: false }; lines.push(`✗ ${day.date} lodging ${l.name} → NO LISTING`); }
    }
  }
  for (const m of day.meals ?? []) {
    if (!m.name) continue;
    const key = `${day.date}:${m.meal}`;
    if (PLACEHOLDER.test(m.name)) { out.meals[key] = { choice: true }; lines.push(`· ${day.date} ${m.meal.padEnd(9)} ${m.name} → a choice, not a place`); continue; }
    // the meal's own "where" beats the day's geometry as the anchor; a hit
    // anywhere within 60 mi of one of the day's stops is on this day's road
    // anchors, in order: the stop whose name shares a word with the meal's
    // "where" (Frackelton's, Sheridan → the Sheridan fuel stop), then the
    // day's middle / first / last. 30 mi: Google caps a bias circle at 50 km;
    // onDay below is the real gate
    const whereTok = new Set(String(m.where ?? '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3));
    const byWhere = wps.find((w) => String(w.name).toLowerCase().split(/[^a-z]+/).some((t) => whereTok.has(t)));
    const anchors = [...new Set([byWhere, wps[Math.floor((wps.length - 1) / 2)], wps[0], wps[wps.length - 1]].filter(Boolean))];
    const q = m.where ? `${m.name} ${m.where}` : m.name;
    let hit = null;
    for (const anchor of anchors) {
      hit = await lookup(q, anchor, { type: 'restaurant', maxMi: 30, restrict: false });
      if (!hit) hit = await lookup(q, anchor, { type: null, maxMi: 30, restrict: false });
      if (hit && nameOverlap(cleanQuery(m.name), hit.name) >= 0.4) break;
      hit = null;
    }
    const onDay = hit && wps.some((w) => milesBetween(w, hit) <= 60);
    if (hit && onDay && nameOverlap(cleanQuery(m.name), hit.name) >= 0.4) { out.meals[key] = { ...rec(hit), verified: 'google' }; lines.push(`✓ ${day.date} ${m.meal.padEnd(9)} ${m.name} → ${hit.name} (${hit.mi} mi)`); }
    else { out.meals[key] = { verified: false, ...(hit ? { candidate: rec(hit) } : {}) }; lines.push(`✗ ${day.date} ${m.meal.padEnd(9)} ${m.name} → NO LISTING${hit ? ` — nearest: ${hit.name} ${hit.mi} mi` : ''}`); }
  }
}
console.log(lines.join('\n'));
const tally = (o, k) => Object.values(o).filter((v) => v.verified === k).length;
console.log(`\nwaypoints: ${tally(out.waypoints, 'google')} verified · ${Object.values(out.waypoints).filter((v) => v.placed).length} placed · ${tally(out.waypoints, false)} unverified / lodging: ${tally(out.lodging, 'google')} verified · ${Object.values(out.lodging).filter((v) => v.placed).length} rider-placed · ${tally(out.lodging, false)} unverified / meals: ${tally(out.meals, 'google')} verified · ${tally(out.meals, false)} unverified`);
if (WRITE) {
  const header = `// GENERATED by tools/verify-seed.mjs on ${out.generatedAt} — do not hand-edit; re-run the verifier.
// Every seed waypoint, meal and night resolved against Google Places: a hit
// carries Google's identity and coordinate (the seed snaps to it at load, see
// seedTrip.js), a scenic stop or road anchor with no listing is PLACED (a
// deliberate coordinate, never presented as verified), a business with none is
// unverified so the rider re-picks it. Airbnbs stay the rider's booked address.
`;
  writeFileSync(`${ROOT}${OUT.file}`, `${header}export const ${OUT.name} = ${JSON.stringify(out, null, 2)};\n`);
  console.log(`wrote ${OUT.file}`);
}

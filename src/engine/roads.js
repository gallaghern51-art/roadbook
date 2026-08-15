// Highway shields for a stop, parsed out of the text the field guide already
// carries ("Depart 5:45 AM, US-14/16/20 East", "I-90 East entrance", "MT-135
// South"). Nothing new to maintain: the road numbers live in the notes, we just
// surface them as shields.
//
// Interstates get the blue/red shield, US routes the white escutcheon, state
// routes a plain square — the same three shapes as real signage.

// Shields are fetched by route key from the `shield` function, which resolves
// them on Wikimedia Commons — see netlify/functions/shield.mjs. There is
// deliberately no list of known routes here: route numbers are unbounded, and
// any such list is a manual step that is never finished.

// Every state, because a trip planner is not a Sturgis planner any more: the
// prefix list used to be the eight states the seed trip crosses, so a Blue
// Ridge day silently drew no shields at all. The hyphen is what keeps this
// from firing on prose — "NC-105" is a route, "NC 105 riders" is not, and
// only the router-ref normalizer below inserts hyphens.
const STATES = ('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO '
  + 'MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' ');
const ROAD_RE = new RegExp(
  `\\b(I|US|${STATES.join('|')})-(\\d{1,3}[A-Z]?(?:/\\d{1,3}[A-Z]?)*)\\b`,
  'g'
);

const KIND = {
  I: 'interstate',
  US: 'us',
};

/**
 * Router text → the hyphenated form ROAD_RE reads.
 *
 * OSRM hands refs back space-separated and semicolon-joined ("I 90",
 * "US 14;US 16;US 20"). Google has no ref field at all and buries the road in
 * the instruction ("Merge onto I-90 E toward Billings").
 */
export function normalizeRoadRef(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/;/g, ' ').replace(/\b([A-Z]{1,2})\s+(\d)/g, '$1-$2');
}

// "Continue on I-90 E", "Merge onto I-90 E toward Billings" → the road you end
// up ON. Deliberately NOT "Take the exit toward US-14": naming the road a sign
// points at would paint a US-14 shield while you are still on the interstate.
const ONTO_RE = /\b(?:onto|on)\s+(.+?)(?:\s+toward\b|,|$)/i;

/**
 * The road a routed step runs on — OSRM's ref when there is one, otherwise
 * whatever the instruction says you are continuing onto.
 */
export function stepRoadShields(step) {
  if (!step) return [];
  const own = roadShields(normalizeRoadRef(step.road));
  if (own.length) return own;
  const m = ONTO_RE.exec(step.instr ?? '');
  return m ? roadShields(normalizeRoadRef(m[1])) : [];
}

/**
 * @returns {{key:string, kind:'interstate'|'us'|'state', prefix:string, num:string}[]}
 */
export function roadShields(...texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    if (!text || typeof text !== 'string') continue;
    ROAD_RE.lastIndex = 0;
    let m;
    while ((m = ROAD_RE.exec(text))) {
      const prefix = m[1];
      // "US-14/16/20" is three shields, not one
      for (const num of m[2].split('/')) {
        const key = `${prefix}-${num}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, kind: KIND[prefix] ?? 'state', prefix, num });
      }
    }
  }
  return out;
}

/**
 * Shields for every stop in a day, index-aligned to day.waypoints.
 *
 * Only some notes name a road ("Shell, WY — Dirty Annie's. Canyon mouth" does
 * not), but you are still on US-14 there, so an unnamed stop inherits the last
 * road stated. `inherited` is set on those so the UI can render them quieter —
 * it is a reasonable guess, not something the guide actually says.
 */
export function dayRoadShields(day) {
  let carried = [];
  return (day.waypoints ?? []).map((w) => {
    const own = roadShields(w.note, w.name);
    if (own.length) {
      carried = own;
      return own;
    }
    return carried.map((s) => ({ ...s, inherited: true }));
  });
}

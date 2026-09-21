// Replacing a proposed stop by hand, with no model (Sep 21, 2026).
//
// Owner: "for changing/editing AI recommended stops should not necessarily
// require another full AI build. they could click a recommended stop and then
// replace with another location. if you recommend one dinner spot and they
// dont want to go there. they should be able to choose replace and then go to
// map and search area for food etc for the stop."
//
// Before this, "Change" on a proposed stop only PREFILLED the chat box; the
// rider then sent it and waited out a full planner turn — Places re-searched,
// every option re-evaluated, tens of seconds and a model call — to move one
// dinner. Now the rider picks the replacement from a live search and the road
// is re-measured by the same evaluator the planner uses, reached directly.
//
// Run: node scripts/concept-edit-check.mjs

import { replaceConceptStop, withDeltas, decodePolyline5, remeasureConcept } from '../src/engine/conceptEdit.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const concept = () => ({
  id: 'opt-a',
  title: 'The Beartooth way',
  routeDescription: 'Out over the pass, dinner at The Grizzly Bar, and down into Cooke City.',
  why: 'The Grizzly Bar is the best dinner on the route.',
  tradeoff: 'Longer than the interstate.',
  searchPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  locations: [
    { name: 'Red Lodge', lat: 45.1855, lng: -109.2468, kind: 'start' },
    { name: 'Beartooth Pass', lat: 44.9696, lng: -109.4700, kind: 'road' },
    {
      name: 'The Grizzly Bar', lat: 45.0224, lng: -109.9312, kind: 'food', dwell: 60,
      placeId: 'g-grizzly', verified: 'google', rating: 4.6, userRatingCount: 900, priceLevel: 'PRICE_LEVEL_MODERATE',
      why: 'Best burger in the park country', hours: ['Mon: 11–10'],
    },
    { name: 'Cooke City', lat: 45.0219, lng: -109.9310, kind: 'end' },
  ],
  metrics: { depart: '06:30', miles: 64, rideMinutes: 96, longestFuelGap: 64, arrival: '09:05' },
});

const NEW_PLACE = {
  id: 'g-soda-butte', source: 'google', name: 'Soda Butte Lodge', detail: '209 US-212, Cooke City MT',
  lat: 45.0200, lng: -109.9290, rating: 4.1, userRatingCount: 210, priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
};

console.log('\nreplacing a stop');
{
  const before = concept();
  const snapshot = JSON.stringify(before);
  const after = replaceConceptStop(before, 2, NEW_PLACE);
  const s = after.locations[2];
  check('the place changes', s.name === 'Soda Butte Lodge' && s.lat === 45.0200, s.name);
  check('its ROLE does not — a dinner is still a dinner', s.kind === 'food');
  check('nor its time on the ground', s.dwell === 60, `${s.dwell}`);
  check('nor its place in the order', after.locations.length === 4 && after.locations[1].name === 'Beartooth Pass');
  check('the ends are untouched', after.locations[0].name === 'Red Lodge' && after.locations[3].name === 'Cooke City');
  check('identity follows the NEW place', s.placeId === 'g-soda-butte' && s.verified === 'google', `${s.placeId} ${s.verified}`);
  check('the new place\'s facts come with it', s.rating === 4.1 && s.userRatingCount === 210 && s.priceLevel === 'PRICE_LEVEL_INEXPENSIVE');
  check('the OLD place\'s blurb and hours do not ride along onto the new one', !s.why && !s.hours);
  check('the measured figures clear — they described a road no longer ridden', after.metrics === null);
  check('the departure they were measured from is kept for the re-measure', after.departAt === '06:30', `${after.departAt}`);
  check('the edit is recorded, so the UI can be honest about the prose',
    after.edits?.length === 1 && after.edits[0].from === 'The Grizzly Bar' && after.edits[0].to === 'Soda Butte Lodge');
  check('the planner\'s prose is left as it was — its words, not ours', after.why === before.why);
  check('the original concept is not mutated', JSON.stringify(before) === snapshot);

  const unlisted = replaceConceptStop(concept(), 2, { name: 'A pullout I like', lat: 45.02, lng: -109.93 });
  check('a place with no listing is explicitly UNverified — the old ✓ never carries over',
    unlisted.locations[2].verified === false && !unlisted.locations[2].placeId);

  const twice = replaceConceptStop(after, 1, { id: 'g-x', source: 'google', name: 'Top of the World Store', lat: 44.95, lng: -109.5 });
  check('edits accumulate', twice.edits.length === 2);
  check('a second edit still knows the original departure', twice.departAt === '06:30', `${twice.departAt}`);

  let threw = 0;
  for (const i of [0, 3, -1, 9, 1.5]) { try { replaceConceptStop(concept(), i, NEW_PLACE); } catch { threw += 1; } }
  check('the start and destination cannot be "replaced" — they are the trip, not a stop', threw === 5, `${threw} of 5 refused`);
  let noLoc = false;
  try { replaceConceptStop(concept(), 2, { name: 'Nowhere' }); } catch { noLoc = true; }
  check('a replacement with no location is refused', noLoc);
}

console.log('\nkeeping the comparison honest');
{
  const a = { id: 'a', metrics: { miles: 100, rideMinutes: 120, deltaMiles: 0, deltaMinutes: 0 } };
  const b = { id: 'b', metrics: { miles: 110, rideMinutes: 140, deltaMiles: 10, deltaMinutes: 20 } };
  const c = { id: 'c', metrics: null }; // being re-measured
  // b gets a faster road after its stop is replaced: it becomes the quickest
  const out = withDeltas([a, { ...b, metrics: { miles: 95, rideMinutes: 110 } }, c]);
  check('an option that became the quickest is now the baseline at +0',
    out[1].metrics.deltaMinutes === 0 && out[1].metrics.deltaMiles === 0, JSON.stringify(out[1].metrics));
  check('…and the one that used to be quickest is now measured against it',
    out[0].metrics.deltaMinutes === 10 && out[0].metrics.deltaMiles === 5, JSON.stringify(out[0].metrics));
  check('an option still being re-measured is left alone, not given a fake zero', out[2].metrics === null);
  check('nothing to compare returns the set unchanged', withDeltas([c])[0] === c);
}

console.log('\nsearching along the proposed road');
{
  // the canonical Google test vector: (38.5,-120.2) (40.7,-120.95) (43.252,-126.453)
  const pts = decodePolyline5('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  check('the proposed road decodes to points', pts.length === 3, `${pts.length}`);
  check('…at the right places',
    Math.abs(pts[0].lat - 38.5) < 1e-6 && Math.abs(pts[0].lng + 120.2) < 1e-6
    && Math.abs(pts[2].lat - 43.252) < 1e-6 && Math.abs(pts[2].lng + 126.453) < 1e-6,
    JSON.stringify(pts));
  check('a truncated string ends the line rather than throwing', Array.isArray(decodePolyline5('_p~iF~ps|U_ul')));
  check('no polyline is no line', decodePolyline5('').length === 0 && decodePolyline5(undefined).length === 0);
}

console.log('\nre-measuring, with no model');
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        options: [{
          id: 'opt-a', title: 'The Beartooth way',
          locations: JSON.parse(init.body).concepts[0].locations,
          searchPolyline: 'NEWLINE',
          metrics: { depart: '06:30', miles: 66, rideMinutes: 99, longestFuelGap: 66, arrival: '09:08' },
        }],
        baselineId: 'opt-a',
      }),
    };
  };
  const edited = replaceConceptStop(concept(), 2, NEW_PLACE);
  const basics = { range: { comfort: 180, absolute: 200 }, pace: 1.08, routePrefs: { style: 'touring', avoidTolls: true } };
  const out = await remeasureConcept(edited, basics, { fetchImpl });
  const sent = calls[0]?.body;

  check('it goes to the evaluator, not the planner', calls[0]?.url === '/.netlify/functions/evaluate-route', calls[0]?.url);
  check('it measures ONE option — the one that changed', sent.concepts.length === 1 && sent.concepts[0].id === 'opt-a');
  check('with the replacement in it', sent.concepts[0].locations[2].name === 'Soda Butte Lodge');
  check('departing at the ORIGINAL time, so the arrival moves only if the road did', sent.depart === '06:30', `${sent.depart}`);
  check('under the rider\'s own road rule', sent.routePrefs?.avoidTolls === true);
  check('with their range and group pace', sent.range?.comfort === 180 && sent.pace === 1.08);
  check('the new figures land', out.metrics.miles === 66 && out.metrics.rideMinutes === 99);
  check('the road to search along is updated too', out.searchPolyline === 'NEWLINE');
  check('the planner\'s prose survives the re-measure', out.why === concept().why);
  check('and so does the record of the edit', out.edits?.length === 1);

  let err = '';
  try {
    await remeasureConcept(edited, basics, {
      fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: 'could not measure the route: valhalla 429' }) }),
    });
  } catch (e) { err = e.message; }
  check('a failed re-measure says why, rather than returning stale figures', /valhalla 429/.test(err), err);

  let err2 = '';
  try {
    await remeasureConcept(edited, basics, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ options: [{ id: 'opt-a', error: 'needs at least two located stops' }] }) }),
    });
  } catch (e) { err2 = e.message; }
  check('an option the router could not measure is an error, not a success with no figures', /two located stops/.test(err2), err2);
}

console.log('\nthe evaluate-route function itself');
{
  const valhallaCalls = [];
  globalThis.fetch = async (url, init) => {
    valhallaCalls.push(String(url));
    if (String(url).includes('/height')) {
      return { ok: true, status: 200, json: async () => ({ height: [1000, 1500, 1200] }) };
    }
    const body = JSON.parse(init.body);
    const n = body.locations.length;
    const legs = Array.from({ length: n - 1 }, () => ({
      shape: '_p~iF~ps|U_ulLnnqC',
      summary: { length: 30, time: 1800 },
      maneuvers: [{ length: 30, time: 1800 }],
    }));
    return { ok: true, status: 200, json: async () => ({ trip: { legs, summary: { length: 30 * (n - 1), time: 1800 * (n - 1) } } }) };
  };
  const { default: handler } = await import('../netlify/functions/evaluate-route.mjs');
  const post = (body) => handler(new Request('http://x/.netlify/functions/evaluate-route', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));

  const res = await post({ concepts: [replaceConceptStop(concept(), 2, NEW_PLACE)], depart: '06:30', pace: 1, range: { comfort: 180, absolute: 200 } });
  const json = await res.json();
  check('it answers', res.status === 200, `${res.status} ${JSON.stringify(json).slice(0, 120)}`);
  check('with measured figures', Number.isFinite(json.options?.[0]?.metrics?.miles), JSON.stringify(json.options?.[0]?.metrics ?? json));
  check('it records the departure it measured from, so the NEXT re-measure can reuse it',
    json.options?.[0]?.metrics?.depart === '06:30', `${json.options?.[0]?.metrics?.depart}`);
  check('it spoke to the router and nothing else — no model, no Anthropic call',
    valhallaCalls.length > 0 && valhallaCalls.every((u) => !/anthropic/i.test(u)), valhallaCalls.join(' '));
  check('it returns no-store, so a re-measure is never served from a cache',
    res.headers.get('cache-control') === 'no-store');

  const bad1 = await post({ concepts: [] });
  check('no concept is a 400', bad1.status === 400);
  const bad2 = await post({ concepts: [{ id: 'x', locations: [{ lat: 1, lng: 1 }] }] });
  check('one located stop is a 400, before any request is spent', bad2.status === 400);
  const many = { id: 'x', locations: Array.from({ length: 25 }, (_, i) => ({ lat: 44 + i * 0.01, lng: -104 })) };
  const bad3 = await post({ concepts: [many] });
  check('more stops than a route can carry is a 400 that says the limit', bad3.status === 400 && /20/.test((await bad3.json()).error));
  const bad4 = await handler(new Request('http://x/', { method: 'GET' }));
  check('only POST', bad4.status === 405);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

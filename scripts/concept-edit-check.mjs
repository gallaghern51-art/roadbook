// Replacing a proposed stop by hand, with no model (Sep 20, 2026).
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

import { replaceConceptStop, replaceableAt, withDeltas, decodePolyline5, remeasureConcept, conceptToTrip } from '../src/engine/conceptEdit.js';
import { settleEvenings, mealOf, dayCountOf } from '../src/engine/dayShape.js';
import { LEADVILLE, JACKSON } from './fixtures/builder-probes.mjs';

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

console.log('\nthe proposal becomes a trip — instantly, no model');
{
  // Owner: "roadbook spits out a recommended plan and then user should be able
  // to edit that and then move things around, or save for later". The trip
  // editor already does all of that; what stood in the way was "Create this
  // trip" running a second full planner generation.
  const sanJuan = {
    id: 'mountain', title: 'Passes + hot springs',
    routeDescription: 'US-550 over the San Juan passes, then a hot-springs stay.',
    metrics: { depart: '06:45', miles: 238 },
    locations: [
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'start' },
      { name: 'Million Dollar Highway', lat: 37.9, lng: -107.67, kind: 'road', detail: 'US-550' },
      { name: 'Conoco, Ouray', lat: 38.02, lng: -107.67, kind: 'fuel', placeId: 'fuel-1', verified: 'google' },
      { name: 'Brickhouse 737', lat: 38.021, lng: -107.671, kind: 'food', placeId: 'food-1', verified: 'google', detail: '737 Main St, Ouray', dwell: 60 },
      { name: 'Ouray Hot Springs', lat: 38.03, lng: -107.67, kind: 'lodging', placeId: 'stay-1', detail: 'Recovery-night anchor' },
      { name: 'Red Mountain Pass', lat: 37.9, lng: -107.71, kind: 'road' },
      { name: 'Silverton Diner', lat: 37.81, lng: -107.66, kind: 'food', detail: 'Verified breakfast stop' },
      { name: 'Durango', lat: 37.2753, lng: -107.8801, kind: 'end' },
    ],
  };
  const basics = { name: 'San Juan Roadbook', riders: 4, pace: 1.15, routePrefs: { style: 'touring', avoidTolls: false } };
  const out = conceptToTrip(sanJuan, basics);
  const days = out.trip.days;

  check('it returns the planner\'s own shape, so it goes through the same normalisation',
    Array.isArray(out.trip?.days) && typeof out.trip?.meta === 'object');
  check('an overnight splits the ride into days', days.length === 2, `${days.length}`);
  check('the overnight ENDS day one…', days[0].waypoints.at(-1).name === 'Ouray Hot Springs');
  check('…and STARTS day two, which is what an overnight is', days[1].waypoints[0].name === 'Ouray Hot Springs');
  const allStops = days.flatMap((d, i) => (i === 0 ? d.waypoints : d.waypoints.slice(1))).map((w) => w.name);
  check('every stop is kept, in order, none lost at the split',
    JSON.stringify(allStops) === JSON.stringify(sanJuan.locations.map((l) => l.name)), allStops.join(' → '));
  check('each day starts on a start and ends on an end',
    days.every((d) => d.waypoints[0].kind === 'start' && d.waypoints.at(-1).kind === 'end'));
  const fuel = days[0].waypoints.find((w) => w.name === 'Conoco, Ouray');
  check('a fuel stop is a fuel stop, and counts toward the fuel plan', fuel.kind === 'fuel' && fuel.fuel === true);
  check('a road-shape anchor stays on the route as a via', days[0].waypoints.find((w) => w.name === 'Million Dollar Highway').kind === 'via');
  check('verified identity comes through — no stop is re-looked-up or downgraded',
    fuel.placeId === 'fuel-1' && fuel.verified === 'google');
  check('time on the ground comes through', days[0].waypoints.find((w) => w.name === 'Brickhouse 737').dwell === 60);
  check('the overnight becomes that day\'s lodging, to reserve',
    days[0].lodging.name === 'Ouray Hot Springs' && days[0].lodging.status === 'reserve');
  check('the last day has no lodging — it ends at home', days[1].lodging.status === 'none');
  check('a food stop also becomes a meal, verified', days[0].meals[0]?.name === 'Brickhouse 737' && days[0].meals[0]?.placeId === 'food-1');
  check('the meal uses the planner\'s own word when it said one ("breakfast stop")',
    days[1].meals[0]?.meal === 'breakfast', JSON.stringify(days[1].meals));
  check('the departure comes through as the app writes it', days[0].depart === '6:45 AM', days[0].depart);
  check('an out-and-back rides its last day home', days[0].phase === 'outbound' && days[1].phase === 'return');
  check('the trip is named what the rider called it', out.trip.meta.title === 'San Juan Roadbook');
  check('the planner\'s route description becomes the trip summary — its words, kept',
    out.trip.meta.summary === sanJuan.routeDescription);
  check('riders, pace and the road rule come from the frame the options were measured under',
    out.trip.meta.riders === 4 && out.trip.meta.pace === 1.15 && out.trip.meta.routePrefs?.style === 'touring');
  check('per-day narratives are NOT invented — left for the planner or the rider',
    days.every((d) => d.summary === ''));

  const oneWay = conceptToTrip({ ...sanJuan, locations: [sanJuan.locations[0], sanJuan.locations[2], { name: 'Montrose', lat: 38.47, lng: -107.87, kind: 'end' }] }, basics);
  check('a one-day ride with no overnight is one day', oneWay.trip.days.length === 1);
  check('and a one-way ride is outbound, never "return"', oneWay.trip.days[0].phase === 'outbound');

  // the stop the rider replaced is the one that gets built
  const edited = replaceConceptStop(sanJuan, 3, { id: 'g-maggies', source: 'google', name: "Maggie's Kitchen", lat: 38.022, lng: -107.672 });
  const built = conceptToTrip(edited, basics);
  const names = built.trip.days[0].waypoints.map((w) => w.name);
  check('a stop the rider replaced by hand is the one that ends up in the trip',
    names.includes("Maggie's Kitchen") && !names.includes('Brickhouse 737'), names.join(' → '));
  check('…as the day\'s meal too', built.trip.days[0].meals[0]?.name === "Maggie's Kitchen");

  let threw = false;
  try { conceptToTrip({ locations: [{ name: 'x', lat: 1, lng: 1 }] }); } catch { threw = true; }
  check('a proposal with no route is refused, not turned into an empty trip', threw);
}

// ── where a day ends (Sep 20, 2026) ──
// Owner: "it would have one full day then the next day would just have a
// dinner or lodging". The fixtures are the live planner's own answers.
console.log('\nWhere a proposal\'s days end');
{
  const names = (list) => list.map((l) => l.name);
  const dayLists = (list) => {
    const out = [[list[0]]];
    for (let i = 1; i < list.length; i++) {
      out.at(-1).push(list[i]);
      if (list[i].kind === 'lodging' && i < list.length - 1) out.push([list[i]]);
    }
    return out.map(names);
  };

  // the report, reproduced from the live answer
  const rawJackson = dayLists(JACKSON.locations);
  check('as the planner sends it, the first night\'s dinner opens Day 2 (the reported shape)',
    rawJackson[1][1] === 'The Bistro' && rawJackson[1].length === 4, JSON.stringify(rawJackson[1]));

  const jackson = settleEvenings(JACKSON.locations);
  const days = dayLists(jackson);
  check('settled, each dinner is eaten on its own evening: Day 1 ends dinner → hotel',
    JSON.stringify(days[0].slice(-2)) === JSON.stringify(['The Bistro', 'The Wort Hotel']), JSON.stringify(days[0]));
  check('Day 2 is the layover loop with ITS dinner before the hotel again',
    JSON.stringify(days[1]) === JSON.stringify(['The Wort Hotel', 'Jenny Lake Overlook', 'Snake River Brewing', 'The Wort Hotel']), JSON.stringify(days[1]));
  check('Day 3 rides home and keeps its lunch', days[2][0] === 'The Wort Hotel' && days[2].includes('Star Valley Roadhouse') && days[2].at(-1) === 'Salt Lake City');
  check('still three days, still every stop', days.length === 3 && jackson.length === JACKSON.locations.length);
  check('settling twice changes nothing', JSON.stringify(settleEvenings(jackson)) === JSON.stringify(jackson));

  const leadville = dayLists(settleEvenings(LEADVILLE.locations));
  check('an UNLABELLED restaurant a few blocks from the hotel is that evening\'s dinner (the Leadville answer)',
    leadville[0].at(-2) === 'The Leadville Grill and Cantina' && leadville[0].at(-1) === 'Historic Delaware Hotel', JSON.stringify(leadville[0]));
  check('…and Day 2 starts at the hotel, riding', leadville[1][0] === 'Historic Delaware Hotel' && leadville[1][1] === 'Trout Creek Pass');

  const hotel = { name: 'Hotel', lat: 45, lng: -110, kind: 'lodging' };
  const base = (after) => [{ name: 'Start', lat: 44, lng: -110, kind: 'start' }, hotel, ...after, { name: 'End', lat: 46, lng: -110, kind: 'end' }];
  const nearby = { lat: 45.005, lng: -110.005 };
  check('breakfast listed after the hotel stays the next morning',
    settleEvenings(base([{ name: 'Diner', ...nearby, kind: 'food', meal: 'breakfast' }]))[1].name === 'Hotel');
  check('so does a lunch', settleEvenings(base([{ name: 'Grill', ...nearby, kind: 'food', preferenceTags: ['lunch'] }]))[1].name === 'Hotel');
  check('an unlabelled café by the hotel reads as breakfast, not dinner',
    settleEvenings(base([{ name: 'Corner', ...nearby, kind: 'food', primaryType: 'cafe' }]))[1].name === 'Hotel');
  check('a dinner 50 miles on is the NEXT day\'s dinner, whatever it is called',
    settleEvenings(base([{ name: 'Far Steakhouse', lat: 45.7, lng: -110, kind: 'food', meal: 'dinner' }]))[1].name === 'Hotel');
  check('a dinner and the drinks after it move together, in order',
    names(settleEvenings(base([{ name: 'Dinner', ...nearby, kind: 'food', meal: 'dinner' }, { name: 'Bar', lat: 45.004, lng: -110.004, kind: 'food' }]))).join('|') === 'Start|Dinner|Bar|Hotel|End');

  const doorstep = settleEvenings([{ name: 'A', lat: 44, lng: -110, kind: 'start' }, hotel, { name: 'Jackson', lat: 45.002, lng: -110.002, kind: 'end' }]);
  check('an end on the last hotel\'s doorstep is not a zero-mile last day — the trip ends at the hotel',
    doorstep.length === 2 && doorstep.at(-1).name === 'Hotel' && dayCountOf(doorstep) === 1);
  check('an end that is actually somewhere else stays',
    settleEvenings([{ name: 'A', lat: 44, lng: -110, kind: 'start' }, hotel, { name: 'B', lat: 45.3, lng: -110, kind: 'end' }]).length === 3);

  check('the meal is the planner\'s word: its field, then its tags',
    mealOf({ kind: 'food', meal: 'lunch', preferenceTags: ['dinner'] }) === 'lunch' && mealOf({ kind: 'food', preferenceTags: ['brewpub', 'dinner'] }) === 'dinner');
  check('…never Google\'s type list (Snake River Brewing is tagged breakfast_restaurant by Google, dinner by the planner)',
    mealOf(JACKSON.locations.find((l) => l.name === 'Snake River Brewing')) === 'dinner');
  check('a day count is one per overnight before the end, plus the last', dayCountOf(JACKSON.locations) === 3 && dayCountOf(LEADVILLE.locations) === 2);

  // the created trip: meals on the right day, named right
  const trip = conceptToTrip(JACKSON, { name: 'Tetons' }).trip;
  const meal = (d, m) => trip.days[d].meals.find((x) => x.meal === m)?.name;
  check('an instant create puts the first night\'s dinner on Day 1, as dinner', meal(0, 'dinner') === 'The Bistro', JSON.stringify(trip.days[0].meals));
  check('the layover\'s dinner on Day 2', meal(1, 'dinner') === 'Snake River Brewing', JSON.stringify(trip.days[1].meals));
  check('Day 3 has its lunch and no stray dinner', meal(2, 'lunch') === 'Star Valley Roadhouse' && !meal(2, 'dinner'), JSON.stringify(trip.days[2].meals));
  check('every overnight is its day\'s lodging', trip.days[0].lodging.name === 'The Wort Hotel' && trip.days[1].lodging.name === 'The Wort Hotel' && trip.days[2].lodging.status === 'none');
  const leadTrip = conceptToTrip(LEADVILLE, {}).trip;
  check('an unlabelled dinner is built as Day 1\'s dinner, not Day 2\'s "lunch"',
    leadTrip.days[0].meals.some((m) => m.name === 'The Leadville Grill and Cantina' && m.meal === 'dinner')
    && !leadTrip.days[1].meals.some((m) => m.name === 'The Leadville Grill and Cantina'), JSON.stringify(leadTrip.days.map((d) => d.meals)));

  // Replace, with the trip ending at a hotel
  check('a hotel the trip ends at can be replaced; the rider\'s own start and a plain end cannot',
    replaceableAt(doorstep, 1) && !replaceableAt(doorstep, 0) && !replaceableAt(JACKSON.locations, JACKSON.locations.length - 1));
  const dinnerIdx = jackson.findIndex((l) => l.name === 'The Bistro');
  const swapped = replaceConceptStop({ locations: jackson }, dinnerIdx, { id: 'g-x', source: 'google', name: 'Gather', lat: 43.48, lng: -110.76 });
  const swappedStop = swapped.locations[dinnerIdx];
  check('a replaced dinner is still the dinner — the meal belongs to the slot',
    swappedStop.meal === 'dinner' && mealOf(swappedStop) === 'dinner');
  check('…but the old place\'s tags do not ride onto the new one', swappedStop.preferenceTags === undefined);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

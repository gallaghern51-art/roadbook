// Place verification — AI-authored stops proved against the places database.
//
// Field report, Aug 16, 2026 (a trip built to Great Falls): "one of the fuel
// stops that AI put in wasn't an actual gas station." Generate mode had no
// place lookup at all, so every station, hotel, and restaurant in a freshly
// built trip was recalled from model memory and nothing checked it. This
// covers the mechanism that now does — including the exact reported case.
//
// Run: node scripts/place-verify-check.mjs

import {
  SPECS, milesBetween, nameOverlap, isPlaceholderName, findPlace,
  planVerification, verifyTrip, planOpVerification, verifyProposal, describeVerification,
} from '../netlify/lib/verify-places.mjs';
import { runGenerate, runChat } from '../netlify/lib/planner-core.mjs';
import { applyOps } from '../src/engine/ops.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// A stand-in for the live database. Each entry is a real place at a real
// coordinate; the fake search matches on text the way Places roughly does
// (token containment), honours includedType strictly, and records every call
// so the tests can assert on what was — and was NOT — looked up.
const GREAT_FALLS = { lat: 47.5053, lng: -111.3008 };
const near = (base, dLat, dLng) => ({ lat: base.lat + dLat, lng: base.lng + dLng });

const DB = [
  { id: 'p_cenex', name: 'Cenex Zip Trip', detail: '1200 10th Ave S, Great Falls, MT', ...near(GREAT_FALLS, 0.004, 0.006), types: ['gas_station'], status: 'OPERATIONAL' },
  { id: 'p_sinclair', name: 'Sinclair', detail: 'US-87 N, Great Falls, MT', ...near(GREAT_FALLS, 0.06, 0.05), types: ['gas_station'], status: 'OPERATIONAL' },
  { id: 'p_deadpump', name: 'Frontier Fuel', detail: 'Closed, Great Falls, MT', ...near(GREAT_FALLS, 0.001, 0.001), types: ['gas_station'], status: 'CLOSED_PERMANENTLY' },
  { id: 'p_heritage', name: 'Best Western Plus Heritage Inn', detail: '1700 Fox Farm Rd, Great Falls, MT', ...near(GREAT_FALLS, 0.01, 0.01), types: ['lodging'], status: 'OPERATIONAL', hours: ['Open 24 hours'] },
  { id: 'p_roadhouse', name: 'Roadhouse Diner', detail: '613 15th St N, Great Falls, MT', ...near(GREAT_FALLS, 0.008, 0.002), types: ['restaurant'], status: 'OPERATIONAL', hours: ['Monday: 11 AM–8 PM'] },
  { id: 'p_far', name: 'Conoco', detail: 'Helena, MT', ...near(GREAT_FALLS, 1.2, 0.4), types: ['gas_station'], status: 'OPERATIONAL' },
];

let calls = [];
const fakeSearch = async (key, query, at, opts = {}) => {
  calls.push({ query, at, type: opts.type, hours: opts.hours, classify: opts.classify });
  const q = query.toLowerCase();
  const words = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  return DB
    .filter((p) => !opts.type || p.types.includes(opts.type)) // strictTypeFiltering
    .filter((p) => {
      // A generic query ("gas station") matches everything of the type; a named
      // one has to share a distinctive word with the place.
      if (/^(gas station|restaurant|lodging|hotel)$/.test(q)) return true;
      const hay = `${p.name} ${p.detail}`.toLowerCase();
      return words.some((w) => w.length > 3 && hay.includes(w));
    })
    .map((p) => ({
      id: p.id, name: p.name, detail: p.detail, lat: p.lat, lng: p.lng,
      ...(opts.classify ? { types: p.types, status: p.status } : {}),
      ...(opts.hours ? { hours: p.hours ?? null } : {}),
    }));
};

console.log('name matching:');
{
  check('exact-ish property name scores high', nameOverlap('Best Western Heritage Inn', 'Best Western Plus Heritage Inn') >= 0.9);
  check('a town name alone does not match a property', nameOverlap('Heritage Inn Great Falls', 'Great Falls') < 0.5);
  check('brand match ignores the word "station"', nameOverlap('Sinclair station', 'Sinclair') === 1);
  check('placeholder: "best option in town"', isPlaceholderName('Best option in town'));
  check('placeholder: "TBD"', isPlaceholderName('TBD'));
  check('placeholder: packed lunch', isPlaceholderName('Packed lunch from the cabin'));
  check('a real name is not a placeholder', !isPlaceholderName('Roadhouse Diner'));
}

console.log('\nfindPlace:');
{
  calls = [];
  const hit = await findPlace('k', { name: 'Cenex Zip Trip', near: GREAT_FALLS, spec: SPECS.fuel, searchImpl: fakeSearch });
  check('resolves a real station', hit?.id === 'p_cenex', JSON.stringify(hit?.name));
  check('asks the database for gas stations only', calls[0]?.type === 'gas_station');
  check('asks for classification so closures can be rejected', calls[0]?.classify === true);
  check('does not pay for opening hours on a fuel stop', calls[0]?.hours === false);
}
{
  // The reported bug: a station name that does not exist anywhere near the pin.
  calls = [];
  const hit = await findPlace('k', { name: "Loaf 'N Jug Travel Center", near: GREAT_FALLS, spec: SPECS.fuel, searchImpl: fakeSearch });
  check('an invented station falls back to the real nearest one', hit?.id === 'p_cenex', JSON.stringify(hit?.name));
  check('the fallback is a second, generic query', calls.length === 2 && calls[1].query === 'gas station');
  check('the fallback is not reported as an exact match', hit?.exact === false);
}
{
  const hit = await findPlace('k', { name: 'Frontier Fuel', near: GREAT_FALLS, spec: SPECS.fuel, searchImpl: fakeSearch });
  check('a permanently closed station never wins', hit?.id !== 'p_deadpump' && hit?.id === 'p_cenex');
}
{
  const hit = await findPlace('k', { name: 'Conoco', near: GREAT_FALLS, spec: SPECS.fuel, searchImpl: fakeSearch });
  check('a station 80+ mi off the pin is not this fuel stop', hit === null || hit.id !== 'p_far', JSON.stringify(hit?.name));
}
{
  // Places matches on address text too, so a "<brand> <town>" query returns
  // every station IN that town. The brand the model named has to win, or
  // verification quietly swaps one real station for a different real one.
  const hit = await findPlace('k', { name: 'Sinclair Great Falls', near: GREAT_FALLS, spec: SPECS.fuel, searchImpl: fakeSearch });
  check('the named brand beats a closer station that merely shares the town', hit?.id === 'p_sinclair', JSON.stringify(hit?.name));
  check('and it counts as an exact match, not a fallback', hit?.exact === true);
}
{
  calls = [];
  const hit = await findPlace('k', { name: 'Nowhere Motel', near: GREAT_FALLS, spec: SPECS.lodging, searchImpl: fakeSearch });
  check('lodging has NO generic fallback (any hotel is not the hotel)', hit === null);
  check('lodging asks once and stops', calls.length === 1 && calls[0].type === 'lodging');
  check('lodging asks for opening hours', calls[0]?.hours === true);
}

console.log('\nverifyTrip — the Great Falls trip:');
const mkTrip = () => ({
  meta: { title: 'Great Falls run' },
  days: [{
    id: 'd1',
    title: 'Bozeman → Great Falls',
    waypoints: [
      { id: 'w1', name: 'Bozeman, MT', lat: 45.6796, lng: -111.0380, kind: 'start' },
      { id: 'w2', name: "Loaf 'N Jug Travel Center", lat: GREAT_FALLS.lat, lng: GREAT_FALLS.lng, kind: 'fuel', fuel: true, mile: 180 },
      { id: 'w3', name: 'Great Falls, MT', lat: GREAT_FALLS.lat, lng: GREAT_FALLS.lng, kind: 'end' },
    ],
    meals: [
      { meal: 'lunch', name: 'Best option in town', where: '' },
      { meal: 'dinner', name: 'Roadhouse Diner', where: '' },
    ],
    lodging: { status: 'reserve', name: 'Best Western Heritage Inn', where: 'Great Falls' },
  }],
});
{
  calls = [];
  const trip = mkTrip();
  const report = await verifyTrip(trip, { key: 'k', searchImpl: fakeSearch });
  const fuelWp = trip.days[0].waypoints[1];
  check('the invented station became the real one', fuelWp.name === 'Cenex Zip Trip', fuelWp.name);
  check('it moved to the real coordinates', Math.abs(fuelWp.lat - DB[0].lat) < 1e-9);
  check('it carries the place id so routing aims at the place', fuelWp.placeId === 'p_cenex');
  check('it is stamped verified', fuelWp.verified === 'google');
  check('legacy field-guide mileage is nulled with the move', fuelWp.mile === null);
  check('the address rides along in the note', String(fuelWp.note).includes('10th Ave'));
  check('lodging resolved to the real property', trip.days[0].lodging.name === 'Best Western Plus Heritage Inn');
  check('lodging gained a real address', String(trip.days[0].lodging.where).includes('Fox Farm'));
  check('lodging carries hours', Array.isArray(trip.days[0].lodging.hours));
  check('the named dinner resolved', trip.days[0].meals[1].placeId === 'p_roadhouse');
  check('the placeholder lunch was left alone', trip.days[0].meals[0].verified === undefined);
  check('and cost no lookup', !calls.some((c) => c.query.toLowerCase().includes('best option')));
  check('non-fuel stops are never looked up', !calls.some((c) => c.query.includes('Bozeman')));
  check('report counts what it checked', report.checked === 3, JSON.stringify(report));
}
{
  // Nothing of the type anywhere near: flag it, never delete it — the rider
  // planned a route through here and a hole in the fuel plan is worse.
  const trip = mkTrip();
  trip.days[0].waypoints[1].lat = 40.0;
  trip.days[0].waypoints[1].lng = -100.0;
  const report = await verifyTrip(trip, { key: 'k', searchImpl: fakeSearch });
  const w = trip.days[0].waypoints[1];
  check('an unconfirmable fuel stop survives', trip.days[0].waypoints.length === 3);
  check('and is stamped unverified', w.verified === false);
  check('and says so in its note', String(w.note).startsWith('⚠ Unverified'));
  check('and is listed in the report', report.unverified.some((u) => u.kind === 'fuel'));
}
{
  // A stop the model DID look up costs nothing.
  calls = [];
  const trip = mkTrip();
  trip.days[0].waypoints[1].placeId = 'p_cenex';
  await verifyTrip(trip, { key: 'k', searchImpl: fakeSearch });
  check('a stop with a placeId is trusted, not re-searched', !calls.some((c) => c.type === 'gas_station'));
  check('and reads as verified in the UI', trip.days[0].waypoints[1].verified === 'model');
}
{
  // Out of time / no key: unchecked must never masquerade as failed.
  const trip = mkTrip();
  const report = await verifyTrip(trip, { key: 'k', deadline: Date.now() - 1, searchImpl: fakeSearch });
  const w = trip.days[0].waypoints[1];
  check('a stop we ran out of time for is left unstamped', w.verified === undefined);
  check('it is not falsely flagged', w.verified !== false && !String(w.note ?? '').includes('Unverified'));
  check('the report says how many were skipped', report.skipped === 3, JSON.stringify(report));
}
{
  const trip = mkTrip();
  const report = await verifyTrip(trip, { key: '', searchImpl: fakeSearch });
  check('no places key: nothing is checked and nothing is flagged', report.configured === false && trip.days[0].waypoints[1].verified === undefined);
}
{
  // A places outage is not evidence a place is fake.
  const trip = mkTrip();
  const boom = async () => { throw new Error('places 429'); };
  const report = await verifyTrip(trip, { key: 'k', searchImpl: boom });
  check('a failing lookup leaves the stop unstamped, not condemned', trip.days[0].waypoints[1].verified === undefined);
  check('and the trip survives intact', trip.days[0].waypoints.length === 3 && report.checked === 0);
}
{
  const trip = mkTrip();
  const order = planVerification(trip).map((t) => t.kind);
  check('fuel is verified before beds and meals', order[0] === 'fuel', order.join(','));
}

console.log('\nverifyProposal — chat ops:');
{
  const trip = mkTrip();
  const proposal = {
    summary: 'Add fuel',
    ops: [
      { op: 'add_waypoint', dayId: 'd1', index: 1, waypoint: { name: 'Pilot Travel Center', lat: GREAT_FALLS.lat, lng: GREAT_FALLS.lng, kind: 'fuel', fuel: true } },
      { op: 'update_waypoint', dayId: 'd1', waypointId: 'w1', patch: { dwell: 20 } },
    ],
  };
  const out = await verifyProposal(proposal, { trip, key: 'k', searchImpl: fakeSearch });
  check('the proposed station was corrected to a real one', proposal.ops[0].waypoint.placeId === 'p_cenex');
  check('the op carries the verification stamp', proposal.ops[0].waypoint.verified === 'google');
  check('a dwell-only edit is not looked up', out.corrected.length === 1);
  check('the correction is stated, not silent', describeVerification(out).includes('Cenex Zip Trip'));
}
{
  const trip = mkTrip();
  const proposal = { summary: 'Move fuel', ops: [{ op: 'update_waypoint', dayId: 'd1', waypointId: 'w2', patch: { lat: 40.0, lng: -100.0 } }] };
  const out = await verifyProposal(proposal, { trip, key: 'k', searchImpl: fakeSearch });
  check('relocating a fuel stop is re-proved', out.unverified.length === 1);
  check('the rider is told it could not be confirmed', describeVerification(out).includes('flagged unverified'));
}
{
  const trip = mkTrip();
  const ops = [
    { op: 'update_lodging', dayId: 'd1', patch: { name: 'Best Western Heritage Inn' } },
    { op: 'update_meal', dayId: 'd1', meal: 'lunch', patch: { name: 'best option in town' } },
    { op: 'update_waypoint', dayId: 'd1', waypointId: 'w2', patch: { lat: 47.5, lng: -111.3, placeId: 'p_cenex' } },
  ];
  const tasks = planOpVerification(ops, trip);
  check('lodging renames are verified', tasks.some((t) => t.kind === 'lodging'));
  check('placeholder meal names are not', !tasks.some((t) => t.kind === 'food'));
  check('an op that already carries a placeId is not re-searched', !tasks.some((t) => t.op === ops[2]));
}

console.log('\nthe stamp is tied to the coordinate (ops.js):');
{
  const trip = {
    meta: {}, days: [{ id: 'd1', waypoints: [{ id: 'w1', name: 'Cenex Zip Trip', lat: 47.5, lng: -111.3, kind: 'fuel', fuel: true, placeId: 'p_cenex', verified: 'google' }] }],
  };
  const wp = (r) => r.trip.days[0].waypoints[0];

  check('dragging the pin drops the verification claim',
    wp(applyOps(trip, [{ op: 'update_waypoint', dayId: 'd1', waypointId: 'w1', patch: { lat: 47.9, lng: -111.9, placeId: null } }])).verified === undefined);

  check('renaming the stop drops it too',
    wp(applyOps(trip, [{ op: 'update_waypoint', dayId: 'd1', waypointId: 'w1', patch: { name: 'Some other station' } }])).verified === undefined);

  // Editors post the whole form back, so a dwell edit arrives carrying the
  // same name — that must not read as a rename and strip the ✓.
  check('an unchanged name in an editor patch keeps the stamp',
    wp(applyOps(trip, [{ op: 'update_waypoint', dayId: 'd1', waypointId: 'w1', patch: { name: 'Cenex Zip Trip', dwell: 15 } }])).verified === 'google');

  check('a verified re-pick keeps its ✓',
    wp(applyOps(trip, [{ op: 'update_waypoint', dayId: 'd1', waypointId: 'w1', patch: { name: 'Sinclair', lat: 47.8, lng: -111.0, placeId: 'p_sinclair', verified: 'google' } }])).verified === 'google');
}

console.log('\nplanner wiring — an itinerary cannot reach a rider unchecked:');
{
  // A stand-in for the model: answers with one tool call, exactly as the SDK
  // stream does. This is the wiring test that would have caught the original
  // bug, where generate mode simply never looked anything up.
  const fakeClient = (content) => ({
    messages: {
      stream: () => ({
        on() {},
        abort() {},
        finalMessage: async () => ({ stop_reason: 'tool_use', content }),
      }),
    },
  });
  const events = [];
  const emit = (e) => events.push(e);
  const built = mkTrip();
  await runGenerate({
    client: fakeClient([{ type: 'tool_use', name: 'generate_trip', input: { trip: built } }]),
    body: { prompt: 'Bozeman to Great Falls', basics: {} },
    emit,
    verifyOpts: { key: 'k', searchImpl: fakeSearch },
  });
  const done = events.find((e) => e.type === 'done');
  check('generate emits the trip', Boolean(done?.trip));
  check('the invented station never reaches the rider', done.trip.days[0].waypoints[1].name === 'Cenex Zip Trip');
  check('the done event carries the verification report', done.verify?.checked === 3);
  check('the build reports a verification phase', events.some((e) => e.type === 'beat' && /verifying/.test(e.note ?? '')));
}
{
  const events = [];
  const proposal = {
    summary: 'Add fuel',
    ops: [{ op: 'add_waypoint', dayId: 'd1', waypoint: { name: 'Pilot Travel Center', lat: GREAT_FALLS.lat, lng: GREAT_FALLS.lng, kind: 'fuel', fuel: true } }],
  };
  const fakeClient = {
    messages: {
      stream: () => ({
        on() {},
        abort() {},
        finalMessage: async () => ({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Added fuel at Great Falls.' },
            { type: 'tool_use', name: 'propose_trip_changes', input: proposal },
          ],
        }),
      }),
    },
  };
  await runChat({
    client: fakeClient,
    body: { messages: [{ role: 'user', content: 'add fuel' }], tripJson: mkTrip(), scenarios: [] },
    emit: (e) => events.push(e),
    verifyOpts: { key: 'k', searchImpl: fakeSearch },
  });
  const done = events.find((e) => e.type === 'done');
  check('a chat proposal that skipped search_places is corrected anyway', done.proposal.ops[0].waypoint.placeId === 'p_cenex');
  check('and the rider is told, in the reply', /Place check/.test(done.text) && /Cenex/.test(done.text));
}

console.log('\ndistance:');
{
  check('milesBetween is sane', Math.abs(milesBetween({ lat: 47, lng: -111 }, { lat: 48, lng: -111 }) - 69) < 1);
  check('a missing coordinate is infinitely far, never zero', milesBetween({ lat: 47, lng: -111 }, { lat: NaN, lng: -111 }) === Infinity);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

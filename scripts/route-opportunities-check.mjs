import assert from 'node:assert/strict';
import { evaluateRouteOptions, preserveAdditiveRefinement } from '../netlify/lib/route-opportunities.mjs';
import { runExplore } from '../netlify/lib/planner-core.mjs';

const enc6 = (points) => {
  let out = '', prevLat = 0, prevLon = 0;
  const part = (number) => {
    let value = number < 0 ? ~(number << 1) : number << 1;
    let text = '';
    while (value >= 0x20) { text += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>= 5; }
    return text + String.fromCharCode(value + 63);
  };
  for (const [lat, lon] of points) {
    const nextLat = Math.round(lat * 1e6), nextLon = Math.round(lon * 1e6);
    out += part(nextLat - prevLat) + part(nextLon - prevLon);
    prevLat = nextLat; prevLon = nextLon;
  }
  return out;
};

const requests = [];
const mockFetch = async (url, options) => {
  const body = JSON.parse(options.body);
  requests.push({ url, body });
  if (url.endsWith('/height')) {
    return { ok: true, json: async () => ({ height: [[0, 1000], [1, 1100], [2, 1050], [3, 1250]] }) };
  }
  const legs = body.locations.slice(1).map((point, i) => ({
    summary: { length: i === 0 ? 80 : 100, time: i === 0 ? 3600 : 5400 },
    shape: enc6([
      [body.locations[i].lat, body.locations[i].lon],
      [point.lat, point.lon],
    ]),
  }));
  const length = legs.reduce((n, leg) => n + leg.summary.length, 0);
  const time = legs.reduce((n, leg) => n + leg.summary.time, 0);
  return { ok: true, json: async () => ({ trip: { summary: { length, time }, legs } }) };
};

const result = await evaluateRouteOptions({
  depart: '08:00', pace: 1.1,
  routePrefs: { style: 'backroads', avoidTolls: true },
  range: { comfort: 100, absolute: 140 },
  concepts: [
    { id: 'a', title: 'Road and lunch', locations: [
      { name: 'Start', lat: 44, lng: -108, kind: 'start' },
      { name: 'Lunch', lat: 44.2, lng: -107.8, kind: 'food', dwell: 45, placeId: 'p1' },
      { name: 'Fuel', lat: 44.4, lng: -107.6, kind: 'fuel', dwell: 20, placeId: 'p2' },
      { name: 'Stay', lat: 44.6, lng: -107.4, kind: 'end' },
    ] },
    { id: 'b', title: 'Direct', locations: [
      { name: 'Start', lat: 44, lng: -108, kind: 'start' },
      { name: 'Fuel', lat: 44.3, lng: -107.7, kind: 'fuel' },
      { name: 'Stay', lat: 44.6, lng: -107.4, kind: 'end' },
    ] },
  ],
}, { fetchImpl: mockFetch, baseUrl: 'https://valhalla.test' });

assert.equal(result.options.length, 2);
assert.equal(requests.filter((r) => r.url.endsWith('/route')).length, 2);
const routeBody = requests.find((r) => r.url.endsWith('/route')).body;
assert.equal(routeBody.costing, 'motorcycle');
assert.equal(routeBody.locations[1].type, 'break_through');
assert.equal(routeBody.costing_options.motorcycle.use_highways, 0.05);
assert.equal(routeBody.costing_options.motorcycle.use_tolls, 0);
assert.equal(routeBody.costing_options.motorcycle.use_trails, 0);
assert.equal(result.options[0].locations[1].placeId, 'p1');
assert.ok(result.options[0].metrics.ascentFeet > 900);
assert.equal(result.options[0].metrics.overComfort, true);
assert.equal(result.options[0].metrics.overAbsolute, false);
assert.equal(result.baselineId, 'b');
assert.ok(result.options[0].metrics.deltaMiles > 0);
assert.ok(result.options[0].metrics.deltaMinutes > 0);

console.log('PASS route opportunities use motorcycle costing, preserve stops, and expose measured tradeoffs');

const multiDay = await evaluateRouteOptions({
  depart: '08:00',
  concepts: [{ id: 'two-days', title: 'Two days', locations: [
    { name: 'Start', lat: 44, lng: -108, kind: 'start' },
    { name: 'Night one', lat: 44.2, lng: -107.8, kind: 'lodging', placeId: 'hotel-1' },
    { name: 'Finish', lat: 44.4, lng: -107.6, kind: 'end' },
  ] }],
}, { fetchImpl: mockFetch, baseUrl: 'https://valhalla.test' });
assert.equal(multiDay.options[0].metrics.dayCount, 2);
assert.equal(multiDay.options[0].metrics.days.length, 2);
assert.equal(multiDay.options[0].metrics.arrival, null);
assert.ok(Number.isFinite(multiDay.options[0].metrics.longestDayMinutes));
console.log('PASS lodging anchors split multi-day route facts instead of producing a false continuous arrival');

const priorWholeTrip = [{ id: 'same-route', title: 'Whole trip', locations: [
  { name: 'Start', lat: 44, lng: -108, kind: 'start' },
  { name: 'Day 1 road', lat: 44.1, lng: -107.9, kind: 'road' },
  { name: 'Night one', lat: 44.2, lng: -107.8, kind: 'lodging', placeId: 'hotel-1' },
  { name: 'Day 2 fuel', lat: 44.3, lng: -107.7, kind: 'fuel', placeId: 'fuel-day-2' },
  { name: 'Day 2 food', lat: 44.35, lng: -107.65, kind: 'food', placeId: 'food-day-2' },
  { name: 'Finish', lat: 44.4, lng: -107.6, kind: 'end' },
] }];
const abbreviatedAddition = {
  concepts: [{ id: 'same-route', title: 'Whole trip', locations: [
    priorWholeTrip[0].locations[0],
    { name: 'Breakfast', lat: 44.02, lng: -107.98, kind: 'food', placeId: 'breakfast-1' },
    priorWholeTrip[0].locations[2],
    priorWholeTrip[0].locations[5],
  ] }],
};
const preserved = preserveAdditiveRefinement(abbreviatedAddition, priorWholeTrip, 'Add another food stop on day 1 for breakfast.');
assert.deepEqual(
  preserved.concepts[0].locations.map((location) => location.name),
  ['Start', 'Breakfast', 'Day 1 road', 'Night one', 'Day 2 fuel', 'Day 2 food', 'Finish'],
);
assert.equal(abbreviatedAddition.concepts[0].locations.length, 4);
const intentionalRemoval = preserveAdditiveRefinement(abbreviatedAddition, priorWholeTrip, 'Add breakfast instead of Day 2 food.');
assert.equal(intentionalRemoval.concepts[0].locations.length, 4);
console.log('PASS additive refinements preserve omitted later-day locations without blocking explicit removals');

const thirteenLocations = Array.from({ length: 13 }, (_, index) => ({
  name: index === 0 ? 'Start' : index === 12 ? 'Finish' : `Anchor ${index}`,
  lat: 44 + index * 0.01,
  lng: -108 + index * 0.01,
  kind: index === 0 ? 'start' : index === 12 ? 'end' : 'road',
}));
const beforeLongRouteRequests = requests.length;
const longRoute = await evaluateRouteOptions({
  concepts: [{ id: 'thirteen', title: 'Thirteen locations', locations: thirteenLocations }],
}, { fetchImpl: mockFetch, baseUrl: 'https://valhalla.test' });
assert.equal(longRoute.options[0].locations.length, 13);
assert.equal(requests.slice(beforeLongRouteRequests).find((request) => request.url.endsWith('/route')).body.locations.length, 13);
console.log('PASS whole-trip evaluation no longer silently truncates location 13 and later days');

const conceptInput = {
  depart: '08:00',
  concepts: [
    { id: 'mountain', title: 'Mountain road', locations: [
      { name: 'Start', lat: 44, lng: -108, kind: 'start' },
      { name: 'Verified lunch', lat: 44.2, lng: -107.8, kind: 'food', placeId: 'google-lunch' },
      { name: 'Fuel candidate', lat: 44.3, lng: -107.7, kind: 'fuel' },
      { name: 'End', lat: 44.4, lng: -107.6, kind: 'end' },
    ] },
    { id: 'direct', title: 'Direct road', locations: [
      { name: 'Start', lat: 44, lng: -108, kind: 'start' },
      { name: 'End', lat: 44.4, lng: -107.6, kind: 'end' },
    ] },
  ],
};
const responses = [
  { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'eval-1', name: 'evaluate_route_options', input: conceptInput }] },
  { stop_reason: 'tool_use', content: [{
    type: 'tool_use', id: 'show-1', name: 'present_route_options', input: {
      message: 'The mountain option earns its detour.', recommendedId: 'mountain',
      options: [
        { evaluationId: 'mountain', summary: 'Best experience', routeDescription: 'Mountain road via lunch', why: 'The road and meal reinforce each other.', groupFit: 'A clean stop for four bikes.', tradeoff: 'Longer.' },
        { evaluationId: 'direct', summary: 'Fastest', routeDescription: 'Direct road', why: 'Saves time.', groupFit: 'Simple.', tradeoff: 'Less memorable.' },
      ],
    },
  }] },
];
const calls = [];
const client = { messages: { stream: (args) => {
  calls.push(args);
  const response = responses.shift();
  return { on() { return this; }, abort() {}, finalMessage: async () => response };
} } };
const events = [];
await runExplore({
  client,
  body: { basics: { riders: 4, numDays: 3 }, messages: [{ role: 'user', content: 'Build a mountain trip.' }] },
  emit: (event) => events.push(event),
  routeOpts: { fetchImpl: mockFetch, baseUrl: 'https://valhalla.test' },
  verifyOpts: {
    key: 'test-key',
    searchImpl: async (_key, _query, near) => [{
      id: 'verified-fuel', name: 'Real Fuel', detail: 'On the route',
      lat: near.lat, lng: near.lng, status: 'OPERATIONAL', hours: ['Open daily'],
    }],
  },
});
const done = events.find((event) => event.type === 'done');
assert.equal(calls.length, 2);
assert.ok(calls[0].tools.some((tool) => tool.name === 'search_places'));
assert.ok(calls[0].tools.some((tool) => tool.name === 'evaluate_route_options'));
assert.ok(calls[0].tools.some((tool) => tool.name === 'present_route_options'));
assert.equal(done.recommendedId, 'mountain');
assert.equal(done.concepts.length, 2);
assert.equal(done.concepts[0].locations[1].placeId, 'google-lunch');
assert.equal(done.concepts[0].locations[2].placeId, 'verified-fuel');
assert.equal(done.concepts[0].locations[2].verified, 'google');
assert.ok(Number.isFinite(done.concepts[0].metrics.miles));
console.log('PASS AI construction researches, evaluates, and returns inspectable route options before generation');

const priorSecondOption = structuredClone(priorWholeTrip[0]);
priorSecondOption.id = 'other-route';
priorSecondOption.title = 'Other whole trip';
const refinementInput = {
  concepts: [priorWholeTrip[0], priorSecondOption].map((concept) => ({
    id: concept.id,
    title: concept.title,
    locations: [
      concept.locations[0],
      { name: 'Breakfast', lat: 44.02, lng: -107.98, kind: 'food', placeId: 'breakfast-1' },
      concept.locations[2],
      concept.locations[5],
    ],
  })),
};
const refinementResponses = [
  { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'eval-refinement', name: 'evaluate_route_options', input: refinementInput }] },
  { stop_reason: 'tool_use', content: [{
    type: 'tool_use', id: 'show-refinement', name: 'present_route_options', input: {
      message: 'Breakfast is now on Day 1.', recommendedId: 'same-route',
      options: [
        { evaluationId: 'same-route', summary: 'Original plus breakfast', routeDescription: 'Complete two-day route', why: 'Breakfast fits.', groupFit: 'Works.', tradeoff: 'Starts later.' },
        { evaluationId: 'other-route', summary: 'Alternative plus breakfast', routeDescription: 'Complete alternative', why: 'Breakfast fits.', groupFit: 'Works.', tradeoff: 'Starts later.' },
      ],
    },
  }] },
];
const refinementClient = { messages: { stream: () => {
  const response = refinementResponses.shift();
  return { on() { return this; }, abort() {}, finalMessage: async () => response };
} } };
const refinementEvents = [];
await runExplore({
  client: refinementClient,
  body: {
    basics: { riders: 1, numDays: 2 },
    concepts: [priorWholeTrip[0], priorSecondOption],
    messages: [
      { role: 'user', content: 'Build a two-day ride.' },
      { role: 'assistant', content: 'Here are two complete choices.' },
      { role: 'user', content: 'Add another food stop on day 1 for breakfast.' },
    ],
  },
  emit: (event) => refinementEvents.push(event),
  routeOpts: { fetchImpl: mockFetch, baseUrl: 'https://valhalla.test' },
  verifyOpts: { key: '' },
});
const refinedDone = refinementEvents.find((event) => event.type === 'done');
assert.deepEqual(
  refinedDone.concepts[0].locations.map((location) => location.name),
  ['Start', 'Breakfast', 'Day 1 road', 'Night one', 'Day 2 fuel', 'Day 2 food', 'Finish'],
);
assert.equal(refinedDone.concepts[0].metrics.dayCount, 2);
console.log('PASS planner refinement keeps the complete second day when asked only to add Day 1 breakfast');

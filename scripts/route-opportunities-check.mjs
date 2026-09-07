import assert from 'node:assert/strict';
import { evaluateRouteOptions } from '../netlify/lib/route-opportunities.mjs';
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

const conceptInput = {
  depart: '08:00',
  concepts: [
    { id: 'mountain', title: 'Mountain road', locations: [
      { name: 'Start', lat: 44, lng: -108, kind: 'start' },
      { name: 'Verified lunch', lat: 44.2, lng: -107.8, kind: 'food', placeId: 'google-lunch' },
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
});
const done = events.find((event) => event.type === 'done');
assert.equal(calls.length, 2);
assert.ok(calls[0].tools.some((tool) => tool.name === 'search_places'));
assert.ok(calls[0].tools.some((tool) => tool.name === 'evaluate_route_options'));
assert.ok(calls[0].tools.some((tool) => tool.name === 'present_route_options'));
assert.equal(done.recommendedId, 'mountain');
assert.equal(done.concepts.length, 2);
assert.equal(done.concepts[0].locations[1].placeId, 'google-lunch');
assert.ok(Number.isFinite(done.concepts[0].metrics.miles));
console.log('PASS AI construction researches, evaluates, and returns inspectable route options before generation');

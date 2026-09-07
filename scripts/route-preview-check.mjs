import assert from 'node:assert/strict';
import { analyzeRouteChange, routeChangeInventory, routeReconciliationPrompt } from '../src/engine/routePreview.js';
import { legKey } from '../src/engine/tripEngine.js';
import { buildChatMessages } from '../netlify/lib/planner-core.mjs';

const start = { id: 'start', name: 'Cody', lat: 44.52, lng: -109.06, kind: 'start' };
const fuel = { id: 'fuel', name: 'Maverik', lat: 44.72, lng: -109.1, kind: 'fuel', fuel: true };
const pass = { id: 'pass', name: 'Chief Joseph Scenic Byway', lat: 44.95, lng: -109.35, kind: 'via' };
const end = { id: 'end', name: 'Bozeman', lat: 45.68, lng: -111.04, kind: 'end' };
const trip = {
  meta: {
    title: 'Test ride', startDate: '2026-09-07', riders: 2, pace: 1.1,
    range: { comfort: 180, absolute: 210 }, routePrefs: { style: 'touring', avoidTolls: false },
  },
  days: [{
    id: 'day-1', dow: 'Mon', date: '2026-09-07', title: 'Cody to Bozeman', phase: 'outbound',
    depart: '8:00 AM', arrive: '', waypoints: [start, fuel, pass, end],
    gates: [{ waypointId: 'pass', by: '3:00 PM', label: 'Pass before weather' }],
    meals: [{ meal: 'lunch', name: 'Roadhouse Grill', where: 'Red Lodge' }],
    lodging: { status: 'booked', name: 'The Lark', where: 'Bozeman' },
    photos: [], modules: [], constraints: [], ops: [],
  }],
  reserveNow: [{ id: 'reservation-1', name: 'Museum tickets', done: true }],
};

const routes = (miles, seconds) => ({
  'day-1': {
    legs: {
      [legKey(start, fuel)]: { miles: miles[0], seconds: seconds[0] },
      [legKey(fuel, pass)]: { miles: miles[1], seconds: seconds[1] },
      [legKey(pass, end)]: { miles: miles[2], seconds: seconds[2] },
    },
    geometry: [[start.lng, start.lat], [end.lng, end.lat]],
  },
});

const current = routes([40, 60, 100], [2400, 4200, 7200]);
const candidate = routes([45, 80, 125], [2700, 5700, 9000]);
const prefs = { style: 'backroads', avoidTolls: true };
const inventory = routeChangeInventory(trip);

assert.ok(inventory.hard.some((item) => item.kind === 'lodging' && item.name === 'The Lark'));
assert.ok(inventory.hard.some((item) => item.kind === 'gate' && item.name === 'Pass before weather'));
assert.ok(inventory.hard.some((item) => item.kind === 'reservation' && item.name === 'Museum tickets'));
assert.ok(inventory.flexible.some((item) => item.kind === 'food' && item.name === 'Roadhouse Grill'));
assert.ok(inventory.flexible.some((item) => item.kind === 'fuel' && item.name === 'Maverik'));
assert.ok(inventory.unlinked.some((item) => item.name === 'Roadhouse Grill'));
assert.equal(inventory.preservedRouteStops, 2);

const analysis = analyzeRouteChange(trip, current, candidate, prefs);
assert.equal(analysis.prefs.style, 'backroads');
assert.ok(analysis.deltaMiles > 0);
assert.ok(analysis.deltaMinutes > 0);
assert.equal(analysis.changedDays.length, 1);
assert.ok(analysis.affectedFlexible.some((item) => item.name === 'Roadhouse Grill'));

const preview = { prefs, analysis };
const prompt = routeReconciliationPrompt(trip, preview, 'Back roads');
assert.match(prompt, /NOT approval/i);
assert.match(prompt, /Google Places Search Along Route/);
assert.match(prompt, /The Lark/);
assert.match(prompt, /Roadhouse Grill/);
assert.match(prompt, /one atomic proposal/);
assert.match(prompt, /<route_reconciliation_request>/);

const chat = buildChatMessages({
  messages: [{ role: 'user', content: 'Find a better lunch.' }],
  tripDigest: 'digest', tripJson: trip, scenarios: [],
  preferenceProfile: { evidenceCount: 2, preferredTags: ['breakfast diner'] },
});
assert.match(chat[0].content, /<rider_place_preferences>/);
assert.match(chat[0].content, /breakfast diner/);

console.log('PASS route character preview locks commitments, measures the draft, and hands flexible stops to deliberate AI reconciliation');

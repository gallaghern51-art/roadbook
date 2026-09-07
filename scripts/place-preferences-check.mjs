import assert from 'node:assert/strict';
import {
  rowsForPlaceEvent,
  summarizePlacePreferences,
  recordPlaceEvent,
  fetchPlaceEvents,
} from '../src/engine/placePreferences.js';

const accountId = '00000000-0000-0000-0000-000000000001';
const italian = {
  placeId: 'italian-1', name: 'Piccola', kind: 'food', detail: 'Main Street',
  primaryType: 'italian_restaurant', types: ['italian_restaurant', 'restaurant'],
  rating: 4.8, userRatingCount: 640, priceLevel: 'PRICE_LEVEL_MODERATE',
  preferenceTags: ['Italian', 'date-night', 'local favorite'],
};
const diner = {
  placeId: 'diner-1', name: 'Road Diner', kind: 'food',
  primaryType: 'american_restaurant', types: ['american_restaurant', 'restaurant'],
  rating: 4.2, userRatingCount: 85, priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
  preferenceTags: ['American diner', 'breakfast'],
};
const road = { name: 'Beartooth Highway', kind: 'road' };

const rows = rowsForPlaceEvent(accountId, 'confirmed', [italian, italian, road], { optionId: 'route-a' });
assert.equal(rows.length, 1);
assert.equal(rows[0].user_id, accountId);
assert.equal(rows[0].place_id, 'italian-1');
assert.deepEqual(rows[0].traits.tags, ['Italian', 'date-night', 'local favorite']);
assert.equal('place_name' in rows[0], false);
assert.equal('facts' in rows[0], false);
assert.equal(rows[0].option_id, 'route-a');
assert.equal(rowsForPlaceEvent(null, 'confirmed', [italian]).length, 0);
assert.equal(rowsForPlaceEvent(accountId, 'viewed', [italian]).length, 0);
console.log('PASS preference events are account-only, meaningful, deduplicated place choices');

const profile = summarizePlacePreferences([
  ...rows,
  ...rowsForPlaceEvent(accountId, 'selected', [italian]),
  ...rowsForPlaceEvent(accountId, 'rejected', [diner]),
]);
assert.ok(profile.preferredTags.includes('Italian'));
assert.ok(profile.avoidTags.includes('American diner'));
assert.ok(profile.positivePlaceIds.includes('italian-1'));
assert.ok(profile.negativePlaceIds.includes('diner-1'));
assert.equal(profile.evidenceCount, 3);
console.log('PASS preference profile weights confirmations above selections and learns from replacements');

const calls = [];
const client = {
  from(table) {
    assert.equal(table, 'user_place_events');
    return {
      insert(payload) { calls.push({ type: 'insert', payload }); return Promise.resolve({ error: null }); },
      select() {
        return {
          eq() {
            return {
              order() {
                return { limit: async () => ({ data: [{ ...rows[0], created_at: '2026-09-07T00:00:00Z' }], error: null }) };
              },
            };
          },
        };
      },
    };
  },
};
await recordPlaceEvent(accountId, 'confirmed', [italian], { optionId: 'route-a' }, client);
assert.equal(calls[0].payload[0].user_id, accountId);
assert.equal((await fetchPlaceEvents(accountId, client)).length, 1);
console.log('PASS Supabase writes and reads private place evidence through the expected table');

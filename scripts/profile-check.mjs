// Rider profile: saved places, riding facts, stated taste, and the bike
// catalog that turns "what do you ride" into the three numbers the
// feasibility engine grades every fuel gap against.

import assert from 'node:assert/strict';
import {
  normalizeProfile, upsertPlace, removePlace, homePlace, placesForPlanner,
  tasteForPlanner, tripDefaults, mergeProfiles, EMPTY_PROFILE,
} from '../src/engine/profile.js';
import { BIKES, searchBikes, rangeFromBike, bikeLabel } from '../src/data/bikes.js';

let pass = 0;
const ok = (label) => { pass++; console.log(`  ok  ${label}`); };

// ---------------------------------------------------------------- places
{
  let p = normalizeProfile(null);
  assert.deepEqual(p.places, []);
  assert.equal(p.riding.style, 'touring');
  ok('an empty profile still carries every default');

  p = upsertPlace(p, { role: 'home', label: 'The house', lat: 40.768, lng: -74.0175, address: '1500 Harbor Blvd' });
  assert.equal(homePlace(p).label, 'The house');
  ok('a home place is saved and findable by role');

  // Two homes is the ambiguity the whole feature exists to remove.
  p = upsertPlace(p, { role: 'home', label: 'The new house', lat: 41.0, lng: -74.2 });
  assert.equal(p.places.filter((x) => x.role === 'home').length, 1);
  assert.equal(homePlace(p).label, 'The new house');
  assert.equal(p.places.length, 2, 'the old one is demoted, not deleted');
  assert.equal(p.places.find((x) => x.label === 'The house').role, 'favorite');
  ok('a second home demotes the first rather than creating a rival');

  // Favourites are allowed to be many.
  p = upsertPlace(p, { role: 'favorite', label: 'The diner', lat: 41.1, lng: -74.1 });
  assert.equal(p.places.filter((x) => x.role === 'favorite').length, 2);
  ok('favorites are not exclusive');

  // Editing keeps identity.
  const id = homePlace(p).id;
  p = upsertPlace(p, { ...homePlace(p), label: 'Home' });
  assert.equal(homePlace(p).id, id);
  assert.equal(p.places.length, 3);
  ok('editing a place keeps its id instead of duplicating it');

  // A place without a real coordinate is not a place.
  const before = p.places.length;
  p = upsertPlace(p, { role: 'favorite', label: 'Somewhere', lat: NaN, lng: undefined });
  assert.equal(p.places.length, before);
  p = upsertPlace(p, { role: 'favorite', label: '   ', lat: 1, lng: 2 });
  assert.equal(p.places.length, before);
  ok('a place with no coordinate or no name is rejected');

  p = removePlace(p, id);
  assert.equal(homePlace(p), null);
  ok('a place can be removed');
}

// -------------------------------------------------------- planner payload
{
  let p = normalizeProfile(null);
  p = upsertPlace(p, { role: 'home', label: 'Home', lat: 40.7680123456, lng: -74.0175987654, address: '1500 Harbor Blvd', note: 'gate code 1234' });
  const sent = placesForPlanner(p);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].role, 'home');
  assert.equal(sent[0].lat, 40.768012, 'coordinates are trimmed, not mangled');
  assert.ok(!('note' in sent[0]), 'private notes do not go to the model');
  assert.ok(!('id' in sent[0]), 'internal ids do not go to the model');
  ok('the planner gets the coordinates and nothing private');

  assert.equal(tasteForPlanner(p), null);
  ok('an untouched taste section sends nothing rather than empty arrays');

  p = { ...p, taste: { ...p.taste, dietary: ['vegetarian', '  '], food: [], notes: '  ' } };
  const taste = tasteForPlanner(p);
  assert.deepEqual(taste, { dietary: ['vegetarian'] });
  ok('blank tags and blank notes are dropped, real ones are kept');
}

// ------------------------------------------------------------ trip frame
{
  const solo = tripDefaults({ riding: { riders: 1 } });
  assert.equal(solo.pace, 1);
  const small = tripDefaults({ riding: { riders: 3 } });
  assert.equal(small.pace, 1.08);
  const big = tripDefaults({ riding: { riders: 7 } });
  assert.equal(big.pace, 1.15);
  ok('group pace is derived from rider count when not set outright');

  const pinned = tripDefaults({ riding: { riders: 7, pace: 1.02 } });
  assert.equal(pinned.pace, 1.02);
  ok('an explicit pace overrides the derivation');

  const d = tripDefaults({ riding: { style: 'backroads', avoidTolls: true, rangeComfort: 150, rangeAbsolute: 190 } });
  assert.deepEqual(d.routePrefs, { style: 'backroads', avoidTolls: true });
  assert.deepEqual(d.range, { comfort: 150, absolute: 190 });
  ok('road style, tolls and range reach the new trip frame');

  assert.equal(tripDefaults(null).range.comfort, 180);
  assert.equal(tripDefaults(undefined).riders, 1);
  ok('a missing profile still yields a usable frame');
}

// --------------------------------------------------------- bike catalog
{
  assert.ok(BIKES.length > 60, `catalog has ${BIKES.length} models`);
  for (const b of BIKES) {
    assert.ok(b.make && b.model, 'every row is named');
    assert.ok(b.electric || (b.tank > 0 && b.mpg > 0), `${bikeLabel(b)} has a tank and economy`);
    assert.ok(!b.electric || b.rangeMi > 0, `${bikeLabel(b)} states a range`);
    assert.ok(b.weight > 100 && b.weight < 1500, `${bikeLabel(b)} has a believable weight (${b.weight})`);
  }
  ok('every catalog row carries what the arithmetic needs');

  // Riders do not type catalog names.
  assert.ok(searchBikes('road glide').some((b) => b.model === 'Road Glide'));
  assert.ok(searchBikes('glide road').some((b) => b.model === 'Road Glide'));
  assert.ok(searchBikes('gs 1250').some((b) => b.model === 'R 1250 GS'));
  assert.ok(searchBikes('goldwing').length === 0, 'a real miss returns nothing rather than a wrong bike');
  assert.ok(searchBikes('gold wing').some((b) => b.model.includes('Gold Wing')));
  ok('search matches the way a rider types');

  assert.deepEqual(searchBikes('a'), [], 'one letter is not a search');
  assert.deepEqual(searchBikes(''), []);
  assert.deepEqual(searchBikes(null), []);
  ok('an empty query returns nothing rather than the whole catalog');

  // 6.0 gal x 38 mpg = 228 absolute; a 20% reserve is 182 comfort.
  const rg = BIKES.find((b) => b.model === 'Road Glide');
  assert.deepEqual(rangeFromBike(rg), { comfort: 182, absolute: 228, mpg: 38 });
  ok('range is tank times economy, with a reserve held back');

  const zero = BIKES.find((b) => b.electric);
  const er = rangeFromBike(zero);
  assert.equal(er.absolute, zero.rangeMi);
  assert.equal(er.mpg, 0);
  ok('an electric bike states its range instead of multiplying a tank');

  assert.equal(rangeFromBike(null), null);
  assert.equal(rangeFromBike({ tank: 0, mpg: 0 }), null);
  ok('an unusable bike yields no range rather than zero miles');

  const comfortUnderAbsolute = BIKES.every((b) => {
    const r = rangeFromBike(b);
    return !r || r.comfort < r.absolute;
  });
  assert.ok(comfortUnderAbsolute);
  ok('comfort range is always inside absolute range');
}

// ------------------------------------------------------------ account merge
{
  const older = { ...EMPTY_PROFILE, places: [{ id: 'a', role: 'home', label: 'Old', lat: 1, lng: 2 }], updatedAt: '2026-01-01T00:00:00.000Z' };
  const newer = { ...EMPTY_PROFILE, places: [{ id: 'b', role: 'home', label: 'New', lat: 3, lng: 4 }], updatedAt: '2026-06-01T00:00:00.000Z' };

  assert.equal(mergeProfiles(older, newer).places[0].label, 'New');
  assert.equal(mergeProfiles(newer, older).places[0].label, 'New');
  ok('the newer profile wins in both directions');

  // A fresh install must not blank a real profile, and an empty cloud row must
  // not blank a real device.
  assert.equal(mergeProfiles(normalizeProfile(null), newer).places[0].label, 'New');
  assert.equal(mergeProfiles(newer, normalizeProfile(null)).places[0].label, 'New');
  ok('a never-edited profile never overwrites one that has been edited');

  assert.deepEqual(mergeProfiles(null, null).places, []);
  ok('two empty profiles merge to an empty profile');
}

console.log(`\n${pass}/${pass} profile checks passed`);

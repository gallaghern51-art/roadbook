// Account restore: does the library survive the round trip? (Aug 15, 2026)
//
// The feature exists because deleting the PWA deleted the roadbook. So the one
// thing that must never happen is the restore itself losing a trip — an empty
// new install syncing its emptiness over a real library, a tombstone eating an
// edit made after the delete, or a merge quietly swapping the trip someone is
// planning right now.
//
// planMerge is pure and merge_library is a reducer case, so both are checkable
// with no network and no browser.
//
// Run: node scripts/account-check.mjs

import { planMerge } from '../src/engine/cloudLibrary.js';
import { reducer, initialState } from '../src/engine/store.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const T0 = '2026-08-10T10:00:00.000Z';
const T1 = '2026-08-11T10:00:00.000Z';
const T2 = '2026-08-12T10:00:00.000Z';

const rec = (id, updatedAt, extra = {}) => ({
  id, name: id, trip: { meta: { title: id }, days: [] }, scenarios: [], chat: [],
  outbox: [], updatedAt, ...extra,
});
const row = (id, updatedAt, extra = {}) => ({
  trip_id: id, name: id, trip: { meta: { title: id }, days: [] }, scenarios: [], chat: [],
  remote: null, deleted_at: null, updated_at: updatedAt, ...extra,
});
const ids = (list) => list.map((r) => r.id ?? r).sort().join(',');

console.log('a new phone, signing in for the first time:');
{
  // The whole point of the feature. Fresh install = one pristine seed record.
  const local = [rec('seed', T0, { seeded: true })];
  const cloud = [row('alps', T1), row('sturgis', T1)];
  const { adopt, drop, push } = planMerge(local, cloud);
  check('both cloud trips come down', ids(adopt) === 'alps,sturgis', ids(adopt));
  check('the untouched template is dropped, not kept as a third trip', ids(drop) === 'seed', ids(drop));
  check('nothing is pushed back up', push.length === 0, ids(push));
}

console.log('a first-ever signup, with real work already on the phone:');
{
  const local = [rec('planned-offline', T1)];
  const { adopt, drop, push } = planMerge(local, []);
  check('the local trip goes up', ids(push) === 'planned-offline', ids(push));
  check('nothing comes down', adopt.length === 0);
  check('nothing is dropped', drop.length === 0, ids(drop));
}

console.log('an EDITED template is not treated as a pristine one:');
{
  // seeded is cleared by the first edit (store.js syncTrip / touchRecord), so
  // the record survives a merge that would have dropped it untouched.
  const local = [rec('seed', T1)];
  const { drop, push } = planMerge(local, [row('alps', T1)]);
  check('it is kept', !drop.includes('seed'), ids(drop));
  check('and backed up', ids(push) === 'seed', ids(push));
}

console.log('the same trip edited on two devices:');
{
  check('newer here wins — push',
    ids(planMerge([rec('a', T2)], [row('a', T1)]).push) === 'a');
  check('newer there wins — adopt',
    ids(planMerge([rec('a', T1)], [row('a', T2)]).adopt) === 'a');
  const same = planMerge([rec('a', T1)], [row('a', T1)]);
  check('same stamp moves nothing', same.push.length === 0 && same.adopt.length === 0);
}

console.log('deletes:');
{
  const gone = planMerge([rec('a', T0)], [row('a', T1, { deleted_at: T1 })]);
  check('deleted on the other phone, untouched here — drop it', ids(gone.drop) === 'a', ids(gone.drop));
  check('and it is not re-uploaded', gone.push.length === 0, ids(gone.push));

  // The rider deleted it on the laptop, then kept working on it on the phone.
  // Their later work is not something a tombstone gets to throw away.
  const revived = planMerge([rec('a', T2)], [row('a', T1, { deleted_at: T1 })]);
  check('edited here AFTER the delete — the work wins', ids(revived.push) === 'a', ids(revived.push));
  check('and it is not dropped', revived.drop.length === 0, ids(revived.drop));
}

console.log('the reducer applying a merge:');
{
  const base = initialState();
  const mine = base.lib.trips[0];

  // Adopting other trips must not disturb the one on screen.
  const st = reducer(
    { ...base, selectedDayId: 'd3' },
    { type: 'merge_library', records: [rec('alps', T1)], remove: [] },
  );
  check('the library grows', st.lib.trips.length === base.lib.trips.length + 1);
  check('the working trip is untouched', st.trip === base.trip);
  check('and so is the day being planned', st.selectedDayId === 'd3');
  check('the active trip does not move', st.lib.activeId === base.lib.activeId);

  // Replacing the ACTIVE record does have to swap the working copy.
  const swapped = reducer(base, {
    type: 'merge_library',
    records: [{ ...rec(mine.id, T2), trip: { meta: { title: 'FROM THE CLOUD' }, days: [] } }],
    remove: [],
  });
  check('a newer copy of the active trip becomes the working copy',
    swapped.trip.meta.title === 'FROM THE CLOUD', swapped.trip.meta.title);

  // Unsent ops belong to this device and no cloud copy knows them.
  const withOutbox = { ...base };
  withOutbox.lib.trips[0].outbox = [{ id: 'ob1', ops: [] }];
  const kept = reducer(withOutbox, {
    type: 'merge_library', records: [rec(mine.id, T2)], remove: [],
  });
  check('the unsent outbox survives being overwritten',
    kept.lib.trips[0].outbox.length === 1, JSON.stringify(kept.lib.trips[0].outbox));

  // Deleting the active trip has to leave the app pointing at something.
  const removed = reducer(
    reducer(base, { type: 'merge_library', records: [rec('alps', T1)], remove: [] }),
    { type: 'merge_library', records: [], remove: [mine.id] },
  );
  check('removing the active trip re-points the library', removed.lib.activeId === 'alps', removed.lib.activeId);
  check('and the working copy follows', removed.trip.meta.title === 'alps', removed.trip.meta.title);

  // A merge that would empty the library is refused: there would be no trip
  // to show and nothing to fall back to.
  const emptied = reducer(base, { type: 'merge_library', records: [], remove: [mine.id] });
  check('a merge that would empty the library is declined', emptied.lib.trips.length === 1);
  check('a no-op merge returns the same state', reducer(base, { type: 'merge_library' }) === base);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

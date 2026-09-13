#!/usr/bin/env node
// "Leave this trip" used to be signOut() — which, for a rider who had since
// created an account, logged them out of their whole library. Leaving is a
// membership change, not an identity change. This drives leaveTrip() against
// a stub client for the three sessions that exist.
import { leaveTrip } from '../src/engine/supabase.js';

let pass = 0, fail = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? pass++ : fail++; };

function stub(user) {
  const calls = { deletes: [], signOut: 0 };
  const client = {
    auth: {
      getUser: async () => ({ data: { user } }),
      signOut: async () => { calls.signOut++; },
    },
    from: (table) => ({
      delete: () => ({
        eq: (k1, v1) => ({
          eq: async (k2, v2) => { calls.deletes.push({ table, [k1]: v1, [k2]: v2 }); return { error: null }; },
        }),
      }),
    }),
  };
  return { client, calls };
}

// 1. an ACCOUNT holder leaves: membership row goes, session stays
{
  const { client, calls } = stub({ id: 'u-account', is_anonymous: false, email: 'rider@example.com' });
  const r = await leaveTrip('trip-1', client);
  check(calls.deletes.length === 1 && calls.deletes[0].trip_id === 'trip-1' && calls.deletes[0].user_id === 'u-account',
    'account holder: own trip_members row deleted');
  check(calls.signOut === 0 && r.signedOut === false, 'account holder: NOT signed out (the reported bug)');
}

// 2. an ANONYMOUS crew session leaves: membership goes, and the session is dropped
{
  const { client, calls } = stub({ id: 'u-anon', is_anonymous: true });
  const r = await leaveTrip('trip-1', client);
  check(calls.deletes.length === 1, 'anonymous rider: membership row deleted');
  check(calls.signOut === 1 && r.signedOut === true, 'anonymous rider: session dropped, so rejoin-by-code stays the heal path');
}

// 3. no session at all: nothing to delete, nothing to sign out
{
  const { client, calls } = stub(null);
  const r = await leaveTrip('trip-1', client);
  check(calls.deletes.length === 0 && calls.signOut === 0 && r.left === false, 'no session: no-op');
}

// 4. sync not configured: safe no-op
{
  const r = await leaveTrip('trip-1', null);
  check(r.left === false && r.signedOut === false, 'unconfigured build: no-op');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);

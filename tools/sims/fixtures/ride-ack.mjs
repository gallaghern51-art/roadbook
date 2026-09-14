// Ride Mode stands behind a one-time safety acknowledgement (RideSafety.jsx).
// Every sim that opens Ride is testing what a rider sees AFTER that — which is
// the normal state, since the gate is answered once per device — so they seed
// the tick rather than clicking through it on every run.
//
// `ride-safety-check.mjs` deliberately does NOT import this: it is the sim that
// owns the gate's own behaviour and has to meet it un-seeded.
//
// The version is read from the app's own source, so bumping RIDE_SAFETY_VERSION
// can never leave a stale literal here silently re-gating fifteen sims.
import { RIDE_SAFETY_VERSION } from '../../../src/data/legal.js';

export async function seedRideAck(page) {
  await page.addInitScript((v) => {
    try { localStorage.setItem('moto.rideSafety.v1', JSON.stringify({ v, at: new Date().toISOString() })); } catch { /* storage refused */ }
  }, RIDE_SAFETY_VERSION);
}

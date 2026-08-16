// Talking to the optimizer, whichever transport is available.
//
// Background first: it runs against a 15-minute ceiling instead of the host's
// ~58s request timeout, which is the difference between a full re-permutation
// finishing and being severed mid-answer. If background functions or blob
// storage are not available on the deployment, fall back to the streaming
// endpoint so the optimizer keeps working rather than failing closed.
//
// Both transports produce the same event objects, so callers do not care which
// one ran: {type:'delta'|'building'|'done'|'error', ...}.

import { readPlannerStream } from './stream.js';

const POLL_MS = 900;
// Long enough for a genuinely big restructure, short enough that a job which
// silently died does not hang the panel forever.
const POLL_TIMEOUT_MS = 12 * 60 * 1000;
// A background job that never claims its record is a deployment without
// background functions — fall back rather than wait out the full timeout.
// Generous on purpose: Netlify can queue a background invocation for several
// seconds under load, and a premature fallback reruns the whole job against
// the streaming budget (~50s), which a full-trip generate barely fits.
const CLAIM_TIMEOUT_MS = 20 * 1000;
// planner-status answers 503 when the blob store errors. One can be a
// transient hiccup; only a streak means the deployment has no working store.
const MAX_UNAVAILABLE_POLLS = 3;

const newJobId = () => (
  globalThis.crypto?.randomUUID?.() ??
  `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runPlanner(payload, onLine) {
  try {
    return await runBackground(payload, onLine);
  } catch (err) {
    if (err?.code !== 'no_background') throw err;
    return runStreaming(payload, onLine);
  }
}

async function runStreaming(payload, onLine) {
  const res = await fetch('/.netlify/functions/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return readPlannerStream(res, onLine);
}

const unavailable = () => Object.assign(new Error('background unavailable'), { code: 'no_background' });

async function runBackground(payload, onLine) {
  const jobId = newJobId();

  const kick = await fetch('/.netlify/functions/planner-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, jobId }),
  }).catch(() => null);

  // Netlify answers a background invocation with 202 and no body. Anything
  // else — 404 on a deployment without them, 500, a network failure — means
  // this transport is not usable here.
  if (!kick || !(kick.status === 202 || kick.ok)) throw unavailable();

  const startedAt = Date.now();
  let claimed = false;
  let unavailableStreak = 0; // consecutive 503s from planner-status
  let deliveredText = 0; // how much of the answer the caller has already seen

  for (;;) {
    await sleep(POLL_MS);

    const res = await fetch(`/.netlify/functions/planner-status?id=${encodeURIComponent(jobId)}`, {
      headers: { 'Cache-Control': 'no-cache' },
    }).catch(() => null);

    if (!res) continue; // a dropped poll on a phone is normal; keep trying
    if (res.status === 503 && !claimed) {
      if (++unavailableStreak >= MAX_UNAVAILABLE_POLLS) throw unavailable(); // blobs really missing
      continue;
    }
    if (!res.ok) continue;
    unavailableStreak = 0;

    const rec = await res.json().catch(() => null);
    if (!rec) continue;

    if (rec.status === 'pending') {
      if (!claimed && Date.now() - startedAt > CLAIM_TIMEOUT_MS) throw unavailable();
      continue;
    }
    claimed = true;

    // Replay only what is new, so callers can append exactly as they would
    // with a live stream.
    if (typeof rec.text === 'string' && rec.text.length > deliveredText && rec.status !== 'done') {
      onLine?.({ type: 'delta', text: rec.text.slice(deliveredText), ms: rec.ms });
      deliveredText = rec.text.length;
    }
    onLine?.({ type: 'building', chars: rec.chars ?? 0, thinking: rec.thinking ?? 0, ms: rec.ms, note: rec.note });

    if (rec.status === 'error') {
      const err = new Error(rec.message || 'The optimizer failed without saying why.');
      err.code = rec.code || 'planner_error';
      throw err;
    }
    if (rec.status === 'done') {
      return { type: 'done', text: rec.text ?? '', proposal: rec.proposal ?? null, trip: rec.trip, verify: rec.verify ?? null };
    }

    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      const err = new Error('The optimizer has been working for over twelve minutes without finishing. Try a smaller request.');
      err.code = 'planner_timeout';
      throw err;
    }
  }
}

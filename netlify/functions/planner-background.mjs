// Trip optimizer — background transport.
//
// The host severs a normal request at ~58s, which is not enough for a full
// re-permutation of an eleven-day trip. Netlify background functions (the
// "-background" filename suffix is what makes this one) get 15 minutes, but
// they answer 202 immediately and cannot stream to the caller. So the job
// reports into a blob record and the client polls planner-status.
//
// The event shapes written here are exactly those the streaming transport
// emits, so the client reads either transport the same way.

import { jobStore } from '../lib/job-store.mjs';
import { makeClient, runChat, runGenerate, friendlyError, BACKGROUND_BUDGET_MS } from '../lib/planner-core.mjs';

// Blob writes are network round-trips; a token-by-token write would cost more
// than the model does. Coalesce to roughly one write a second, but never lose
// the terminal record.
const FLUSH_MS = 900;

export default async (req) => {
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const { jobId } = body;
  if (!jobId) return new Response('jobId required', { status: 400 });

  const store = await jobStore();
  const t0 = Date.now();
  const record = { status: 'running', text: '', chars: 0, thinking: 0, ms: 0, proposal: null, message: null };

  let lastFlush = 0;
  let pending = null;
  const write = async () => {
    lastFlush = Date.now();
    pending = null;
    record.ms = Date.now() - t0;
    try {
      await store.setJSON(jobId, record);
    } catch {
      /* a dropped progress write is survivable; the terminal write retries */
    }
  };
  const flush = (force) => {
    if (force) return write();
    if (Date.now() - lastFlush >= FLUSH_MS && !pending) {
      pending = write();
    }
    return pending ?? Promise.resolve();
  };

  // runChat/runGenerate call emit synchronously; accumulate and let the
  // throttle decide when it is worth a round-trip.
  const emit = (obj) => {
    if (obj.type === 'delta') record.text += obj.text;
    else if (obj.type === 'building') {
      record.chars = obj.chars ?? record.chars;
      record.thinking = obj.thinking ?? record.thinking;
    } else if (obj.type === 'beat' && obj.note) {
      // Phase labels (place verification) — the streaming transport shows
      // these as they arrive; here they have to ride the polled record or a
      // background build looks stalled through the whole check.
      record.note = obj.note;
    } else if (obj.type === 'done') {
      record.status = 'done';
      if (obj.text) record.text = obj.text;
      if (obj.proposal !== undefined) record.proposal = obj.proposal;
      if (obj.trip !== undefined) record.trip = obj.trip;
      if (obj.verify !== undefined) record.verify = obj.verify;
    } else if (obj.type === 'error') {
      record.status = 'error';
      record.message = obj.message;
    }
    flush(obj.type === 'done' || obj.type === 'error');
  };

  await write(); // claim the job immediately so polling sees "running", not "pending"

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw Object.assign(new Error('ANTHROPIC_API_KEY is not set on this Netlify site.'), { status: 401, code: 'not_configured' });
    }
    const client = makeClient();
    if (body.mode === 'generate') {
      await runGenerate({ client, body, emit, budgetMs: BACKGROUND_BUDGET_MS, background: true });
    } else {
      await runChat({ client, body, emit, budgetMs: BACKGROUND_BUDGET_MS, background: true });
    }
  } catch (err) {
    record.status = 'error';
    record.message = friendlyError(err);
    if (err?.code) record.code = err.code;
  }

  // A job that ends without a terminal status was killed mid-flight; say so
  // rather than leaving the client polling a record that never resolves.
  if (record.status === 'running') {
    record.status = 'error';
    record.message = 'The optimizer stopped before finishing, and did not say why. Try a smaller request.';
  }
  await write();
  return new Response('ok');
};

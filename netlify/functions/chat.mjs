// Trip optimizer chat — streaming transport.
// Runs the shared planner core inside the host's request timeout and streams
// NDJSON back. Long jobs that cannot fit belong on planner-background.mjs,
// which runs the same core against the 15-minute background ceiling.

import { makeClient, runChat, runExplore, runGenerate, friendlyError, BUDGET_MS } from '../lib/planner-core.mjs';

// NDJSON lines: {type:'start'|'delta'|'building'|'beat'|'done'|'error', ms}.
// A heartbeat keeps bytes flowing while the model works.
function streamResponse(run) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      let closed = false;
      const t0 = Date.now();
      // enqueue throws once the stream is torn down. A failed send must never be
      // the thing that takes down the error handler below — that turns a
      // reportable failure into a silent truncated stream.
      // Every line carries elapsed ms, so if the host severs the stream the last
      // line the client received measures the host's real cap.
      const send = (obj) => {
        if (closed) return false;
        try {
          controller.enqueue(enc.encode(JSON.stringify({ ...obj, ms: Date.now() - t0 }) + '\n'));
          return true;
        } catch {
          closed = true;
          return false;
        }
      };
      send({ type: 'start' });
      const beat = setInterval(() => send({ type: 'beat' }), 2000);
      try {
        await run(send);
      } catch (err) {
        send({ type: 'error', message: friendlyError(err) });
      } finally {
        clearInterval(beat);
        closed = true;
        try { controller.close(); } catch { /* already torn down */ }
      }
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' } });
}

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: 'POST only' }, { status: 405 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'not_configured', message: 'ANTHROPIC_API_KEY is not set on this Netlify site.' }, { status: 503 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const client = makeClient();

  if (body.mode === 'generate') {
    if (!body.prompt) return Response.json({ error: 'prompt required' }, { status: 400 });
    return streamResponse((send) => runGenerate({ client, body, emit: send, budgetMs: BUDGET_MS }));
  }

  if (body.mode === 'explore') {
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return Response.json({ error: 'messages required' }, { status: 400 });
    }
    return streamResponse((send) => runExplore({ client, body, emit: send, budgetMs: BUDGET_MS }));
  }

  if (!Array.isArray(body.messages) || !body.messages.length) {
    return Response.json({ error: 'messages required' }, { status: 400 });
  }
  return streamResponse((send) => runChat({ client, body, emit: send, budgetMs: BUDGET_MS }));
};

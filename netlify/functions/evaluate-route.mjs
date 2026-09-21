// Re-measure a proposed route WITHOUT the model.
//
// Owner, Sep 21 2026: "for changing/editing AI recommended stops should not
// necessarily require another full AI build. they could click a recommended
// stop and then replace with another location."
//
// When the builder proposes a trip, every figure on it — miles, riding time,
// fuel gap, climbing, arrival — comes from `evaluateRouteOptions`, which is
// pure Valhalla measurement. Until now the ONLY door to it was the model's
// tool call, so replacing one dinner spot meant a full planner turn: the model
// re-searched Places and re-evaluated everything, tens of seconds and a model
// call, to move one pin.
//
// This is that measurement and nothing else. The rider picks the replacement
// themselves from a live Places search (so it arrives already verified), the
// client swaps it into the concept, and this answers with fresh figures in a
// second or two. No model, no prompt, no Anthropic call — a plain synchronous
// function is right here: it routes one concept, well inside Netlify's 10s
// limit, unlike the planner functions that must stream.

import { evaluateRouteOptions, MAX_ROUTE_LOCATIONS } from '../lib/route-opportunities.mjs';

const finite = (v) => Number.isFinite(Number(v));

export default async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'bad JSON' }, { status: 400 });
  }

  const concepts = Array.isArray(body?.concepts) ? body.concepts.slice(0, 3) : [];
  if (!concepts.length) return Response.json({ error: 'need at least one concept' }, { status: 400 });

  // Refuse anything the router would refuse, before spending a request on it.
  for (const c of concepts) {
    const located = (c.locations ?? []).filter((p) => finite(p?.lat) && finite(p?.lng));
    if (located.length < 2) {
      return Response.json({ error: `${c.title || 'an option'} needs at least two located stops` }, { status: 400 });
    }
    if (located.length > MAX_ROUTE_LOCATIONS) {
      return Response.json({ error: `${c.title || 'an option'} has ${located.length} stops; the most a route can carry is ${MAX_ROUTE_LOCATIONS}` }, { status: 400 });
    }
  }

  try {
    const result = await evaluateRouteOptions({
      concepts,
      range: body.range,
      pace: body.pace,
      depart: body.depart,
      routePrefs: body.routePrefs,
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: `could not measure the route: ${String(e.message || e).slice(0, 200)}` }, { status: 502 });
  }
};

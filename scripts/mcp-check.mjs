// The Roadbook MCP server, end to end, with no network and no Supabase.
//
// Drives the REAL server (netlify/lib/mcp-server.mjs) through the same
// Streamable-HTTP transport the deployed function uses, with Valhalla, Google
// Routes and Places answered by mocks and the rider's library held in a fake
// user_trips table. The point is the contract: a rider's own AI asks for
// roads, sees every option with traffic and tolls, saves the one they tap,
// and the saved document is one the app already reads.
//
// Run: node scripts/mcp-check.mjs      (or npm run mcp:check)

import { handleMcpRequest, buildServer } from '../netlify/lib/mcp-server.mjs';
import { authenticate, protectedResourceMetadata, wwwAuthenticate, hashToken, mintToken, AuthError } from '../netlify/lib/mcp-auth.mjs';
import { _resetMemStore } from '../netlify/lib/mcp-store.mjs';
import { ROUTE_OPTIONS_HTML, TRIP_HTML } from '../netlify/lib/mcp-ui.mjs';
import { resetRouterBackoff } from '../src/engine/routing.js';
import mcpFunction from '../netlify/functions/mcp.mjs';
import metadataFunction from '../netlify/functions/mcp-oauth-metadata.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- mocks ----

function encode6(points) {
  let lat = 0; let lng = 0; let out = '';
  const chunk = (v) => {
    let n = v < 0 ? ~(v << 1) : (v << 1);
    let s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const [x, y] of points) {
    const la = Math.round(y * 1e6); const ln = Math.round(x * 1e6);
    out += chunk(la - lat) + chunk(ln - lng);
    lat = la; lng = ln;
  }
  return out;
}

// Red Lodge → Cooke City-ish: three synthetic roads with the shapes the merge
// needs — a highway (short, fast), a scenic road (longer, slower), and an
// alternate that the "quick" costing ranks second but is actually faster.
const A = [-109.25, 45.19]; const B = [-109.93, 45.02];
const line = (bulge, n = 60) => Array.from({ length: n }, (_, i) => {
  const f = i / (n - 1);
  return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f + Math.sin(f * Math.PI) * bulge];
});
const ROADS = {
  highway: { shape: line(0.02), miles: 64.5, minutes: 95, names: ['US 212'], toll: false },
  scenic: { shape: line(0.25), miles: 92.0, minutes: 150, names: ['MT 308', 'MT 72'], toll: false },
  turnpike: { shape: line(-0.2), miles: 60.2, minutes: 84, names: ['I 90'], toll: true },
};
const vTrip = (r, locs) => ({
  summary: { length: r.miles, time: r.minutes * 60, has_toll: r.toll },
  legs: [{ shape: encode6(r.shape), maneuvers: [{ length: r.miles, street_names: r.names, begin_shape_index: 0, type: 1, time: r.minutes * 60 }], summary: { length: r.miles, time: r.minutes * 60 } }],
});

const seen = { valhalla: [], google: [], places: [] };
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('valhalla1.openstreetmap.de/route')) {
    const body = JSON.parse(init.body);
    seen.valhalla.push(body);
    const hw = body.costing_options?.motorcycle?.use_highways ?? 0.5;
    const noToll = body.costing_options?.motorcycle?.use_tolls === 0;
    const two = body.locations.length === 2;
    const alts = (list) => (two && body.alternates ? list.map((r) => ({ trip: vTrip(r) })) : []);
    if (hw >= 1) return Response.json({ trip: vTrip(ROADS.highway), alternates: alts(noToll ? [ROADS.scenic] : [ROADS.turnpike, ROADS.scenic]) });
    if (hw <= 0.1) return Response.json({ trip: vTrip(ROADS.scenic), alternates: alts([ROADS.highway]) });
    return Response.json({ trip: vTrip(ROADS.highway), alternates: alts(noToll ? [ROADS.scenic] : [ROADS.turnpike]) });
  }
  if (u.includes('valhalla1.openstreetmap.de/height')) return Response.json({ height: [[0, 1600], [500, 1700], [1000, 1650]] });
  if (u.includes('routes.googleapis.com')) {
    const body = JSON.parse(init.body);
    seen.google.push(body);
    const vias = (body.intermediates ?? []).filter((i) => i.via).length;
    const toll = body.routeModifiers?.avoidTolls ? null : { estimatedPrice: [{ currencyCode: 'USD', units: '7', nanos: 500000000 }] };
    return Response.json({ routes: [{ duration: `${(vias ? 112 : 130) * 60}s`, distanceMeters: 104000, polyline: { geoJsonLinestring: { coordinates: line(0.02, 10) } }, legs: [], ...(body.extraComputations?.includes('TOLLS') && toll ? { travelAdvisory: { tollInfo: toll } } : {}) }] });
  }
  if (u.includes('places.googleapis.com')) {
    const body = JSON.parse(init.body);
    seen.places.push(body);
    const q = String(body.textQuery || '');
    const along = !!body.searchAlongRouteParameters;
    return Response.json({
      places: [{ id: `pl_${q.replace(/\W+/g, '_').slice(0, 20)}`, displayName: { text: q.includes('Town Pump') ? 'Town Pump' : q.includes('Cooke') ? 'Cooke City, MT' : q }, formattedAddress: `${q}, MT`, location: { latitude: 45.1, longitude: -109.5 }, types: ['gas_station'], primaryType: 'gas_station', businessStatus: 'OPERATIONAL', rating: 4.2, userRatingCount: 88 }],
      ...(along ? { routingSummaries: [{ legs: [{ distanceMeters: 30000, duration: '1800s' }] }] } : {}),
    });
  }
  return nodeFetch(url, init);
};

// A fake Supabase query builder over arrays: only the calls the server makes.
function fakeDb() {
  const tables = { user_trips: [], user_profile: [], mcp_tokens: [] };
  const builder = (name) => {
    const rows = tables[name];
    const st = { filters: [], order: null, op: 'select', payload: null, single: false, returning: false };
    const apply = () => rows.filter((r) => st.filters.every((f) => f(r)));
    const q = {
      select(cols) { if (st.op === 'update') st.returning = true; else st.op = 'select'; st.cols = cols; return q; },
      eq(k, v) { st.filters.push((r) => r[k] === v); return q; },
      is(k, v) { st.filters.push((r) => r[k] == v); return q; },
      order() { return q; },
      maybeSingle() { st.single = true; return q; },
      upsert(row) { st.op = 'upsert'; st.payload = row; return q; },
      update(patch) { st.op = 'update'; st.payload = patch; return q; },
      insert(row) { st.op = 'insert'; st.payload = row; return q; },
      then(resolve, reject) {
        try {
          if (st.op === 'upsert') {
            const rowsIn = Array.isArray(st.payload) ? st.payload : [st.payload];
            for (const r of rowsIn) {
              const i = rows.findIndex((x) => x.user_id === r.user_id && x.trip_id === r.trip_id);
              if (i >= 0) rows[i] = { ...rows[i], ...r }; else rows.push({ ...r });
            }
            return resolve({ data: null, error: null });
          }
          if (st.op === 'insert') { rows.push({ id: `id${rows.length + 1}`, ...st.payload }); return resolve({ data: null, error: null }); }
          if (st.op === 'update') {
            const hit = apply();
            for (const r of hit) Object.assign(r, st.payload);
            return resolve({ data: st.returning ? hit : null, error: null });
          }
          const hit = apply();
          return resolve({ data: st.single ? (hit[0] ?? null) : hit, error: null });
        } catch (e) { return reject(e); }
      },
    };
    return q;
  };
  return { from: builder, tables };
}

const db = fakeDb();
db.tables.user_profile.push({ user_id: 'rider-1', profile: { places: [{ role: 'home', name: 'Missoula, MT', lat: 46.87, lng: -113.99 }], bike: '2020 Gold Wing', routePrefs: { style: 'touring', avoidTolls: false }, range: { comfort: 180, absolute: 200 } }, updated_at: '2026-09-01T00:00:00Z' });
const session = { userId: 'rider-1', email: 'rider@example.com', name: 'Niall', via: 'token', db };
// A budgeted verification pass: at most two unchecked stops per call, so the
// resumable path (create_trip → verify_trip → verify_trip) is exercised.
const verifyStub = async (trip, { retryUnverified = true } = {}) => {
  const report = { checked: 0, snapped: 0, unverified: [], configured: true };
  for (const day of trip.days) {
    for (const w of day.waypoints) {
      if (report.checked >= 2) return report;
      if (w.placeId || w.placed) continue;
      if (w.verified === false && !retryUnverified) continue;
      if (w.verified === 'google') continue;
      report.checked += 1;
      if (/nowhere/i.test(w.name)) { w.verified = false; report.unverified.push({ kind: 'fuel', name: w.name }); }
      else { w.placeId = `pl_${w.name.replace(/\W+/g, '_')}`; w.verified = 'google'; report.snapped += 1; }
    }
    if (day.lodging?.name && !day.lodging.placeId && day.lodging.verified !== false && report.checked < 2) { report.checked += 1; day.lodging.placeId = 'pl_lodge'; day.lodging.verified = 'google'; }
    for (const m of day.meals ?? []) { if (!m.placeId && report.checked < 2) { report.checked += 1; m.placeId = 'pl_meal'; m.verified = 'google'; } }
  }
  return report;
};
const deps = { googleKey: 'test-key', verifyTripImpl: verifyStub, verifyProposalImpl: async () => ({ corrected: [{ kind: 'fuel', was: 'Town Pump Red Lodge', now: 'Town Pump', mi: 0.2 }], unverified: [] }) };

let rpcId = 0;
async function rpc(method, params = {}) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const res = await handleMcpRequest(req, session, { deps });
  const txt = await res.text();
  return { status: res.status, ...(txt ? JSON.parse(txt) : {}) };
}
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });

// ------------------------------------------------------------ the checks ----

console.log('protocol:');
{
  const r = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } });
  check('initialize answers as roadbook', r.result?.serverInfo?.name === 'roadbook', JSON.stringify(r).slice(0, 200));
  check('instructions tell the model the flow', /route_options/.test(r.result?.instructions ?? ''));
  const t = await rpc('tools/list');
  const names = (t.result?.tools ?? []).map((x) => x.name);
  check('thirteen tools', names.length === 13, names.join(','));
  for (const n of ['search_places', 'route_options', 'save_route_option', 'traffic_eta', 'evaluate_trip_concept', 'create_trip', 'list_trips', 'get_trip', 'update_trip', 'delete_trip', 'export_gpx', 'rider_profile', 'verify_trip']) {
    if (!names.includes(n)) check(`tool ${n}`, false);
  }
  const ui = Object.fromEntries((t.result?.tools ?? []).map((x) => [x.name, x._meta?.['ui/resourceUri'] ?? x._meta?.ui?.resourceUri ?? null]));
  check('route_options renders the picker app', ui.route_options === 'ui://roadbook/route-options', String(ui.route_options));
  check('save / create / get render the trip app', ['save_route_option', 'create_trip', 'get_trip'].every((n) => ui[n] === 'ui://roadbook/trip'), JSON.stringify(ui));
  check('update_trip is marked destructive, list read-only', t.result.tools.find((x) => x.name === 'update_trip').annotations?.destructiveHint === true && t.result.tools.find((x) => x.name === 'list_trips').annotations?.readOnlyHint === true);
  const res = await rpc('resources/list');
  const uris = (res.result?.resources ?? []).map((x) => x.uri);
  check('UI resources are listed with the MCP Apps mime', uris.includes('ui://roadbook/route-options') && uris.includes('ui://roadbook/trip') && res.result.resources.every((x) => !x.uri.startsWith('ui://') || x.mimeType === 'text/html;profile=mcp-app'), uris.join(','));
  const rd = await rpc('resources/read', { uri: 'ui://roadbook/route-options' });
  const html = rd.result?.contents?.[0]?.text ?? '';
  check('picker HTML speaks the MCP Apps protocol', /ui\/initialize/.test(html) && /ui\/notifications\/tool-result/.test(html) && /ui\/notifications\/initialized/.test(html) && /size-changed/.test(html));
  check('picker calls save_route_option back through the host', /tools\/call/.test(html) && /save_route_option/.test(html));
  check('picker opens the app with ui/open-link', /ui\/open-link/.test(html));
  check('picker declares the basemap domain in its CSP', rd.result?.contents?.[0]?._meta?.ui?.csp?.resourceDomains?.includes('https://server.arcgisonline.com'));
  check('trip HTML is a document of its own', /ui\/notifications\/tool-result/.test(TRIP_HTML) && TRIP_HTML !== ROUTE_OPTIONS_HTML && !/\${/.test(TRIP_HTML) && !/\${/.test(ROUTE_OPTIONS_HTML));
  const p = await rpc('prompts/get', { name: 'plan_a_ride', arguments: { from: 'Red Lodge', to: 'Cooke City', when: 'Saturday' } });
  check('plan_a_ride prompt names the tools in order', /route_options/.test(p.result?.messages?.[0]?.content?.text ?? '') && /save_route_option/.test(p.result?.messages?.[0]?.content?.text ?? ''));
}

console.log('rider profile:');
{
  const r = await call('rider_profile');
  check('profile reads home, bike and range', /Missoula/.test(r.result?.content?.[0]?.text ?? '') && r.result?.structuredContent?.bike === '2020 Gold Wing' && r.result.structuredContent.range.comfort === 180, JSON.stringify(r).slice(0, 200));
}

console.log('route options:');
let optionSetId; let options;
{
  resetRouterBackoff();
  seen.valhalla.length = 0; seen.google.length = 0;
  const r = await call('route_options', { start: { lat: A[1], lng: A[0], name: 'Red Lodge' }, end: 'Cooke City, MT', date: '2027-07-10', time: '9:00 AM', prefer: 'touring' });
  const sc = r.result?.structuredContent;
  check('measures without error', r.result && !r.result.isError, JSON.stringify(r).slice(0, 300));
  check('a named destination was resolved through Places with its id', sc?.end?.placeId === 'pl_Cooke_City_MT' && sc.end.name === 'Cooke City, MT', JSON.stringify(sc?.end));
  check('every style asked one at a time, in order', seen.valhalla.map((b) => b.costing_options.motorcycle.use_highways).join(',') === '1,0.5,0.05', seen.valhalla.map((b) => b.costing_options.motorcycle.use_highways).join(','));
  options = sc?.options ?? [];
  optionSetId = sc?.optionSetId;
  check('an optionSetId comes back for the save step', typeof optionSetId === 'string' && /optionSetId: opt_/.test(r.result.content[0].text));
  check('three distinct roads', options.length === 3, options.map((o) => `${o.label}/${o.miles}`).join(' | '));
  const quick = options.find((o) => o.styles.includes('quick'));
  check('Quick is answered with the FASTEST road of its set (the turnpike alternate)', quick && quick.miles === 60.2 && quick.minutes === Math.round(84 * 1.08), JSON.stringify(quick && { miles: quick.miles, minutes: quick.minutes }));
  check('the rider\'s own character leads the list', options[0].styles.includes('touring'), options[0].label);
  check('fastest / shortest flags and deltas are set', options.some((o) => o.fastest) && options.some((o) => o.shortest) && options.every((o) => Number.isFinite(o.deltaMinutes)));
  check('a tolled road is flagged and PRICED', quick.hasToll && quick.toll && quick.toll.amount === 7.5 && quick.toll.currency === 'USD', JSON.stringify(quick.toll));
  check('traffic is quoted per option for the departure', options.every((o) => o.traffic && o.traffic.at === '2027-07-10T09:00:00.000Z' && o.traffic.minutes > 0), JSON.stringify(options[0].traffic));
  check('a two-point ride pins the quote to Valhalla\'s road with pass-through points', seen.google.every((b) => (b.intermediates ?? []).filter((i) => i.via).length === 4) && options.every((o) => o.traffic.pinned));
  check('a traffic quote carries the departure to Google', seen.google.every((b) => b.departureTime === '2027-07-10T09:00:00.000Z' && b.routingPreference === 'TRAFFIC_AWARE'));
  check('geometry is thinned for the picker, never the survey', options.every((o) => Array.isArray(o.geometry) && o.geometry.length <= 300 && o.geometry.length >= 10));
  check('via labels name the road', options.some((o) => /US-212|I-90|MT-308/.test(o.via ?? '')), options.map((o) => o.via).join(' | '));
  check('text tells the model each option with its id', options.every((o) => r.result.content[0].text.includes(`[${o.id}]`)));
}

console.log('route options, with a stop and no tolls:');
{
  resetRouterBackoff();
  seen.valhalla.length = 0; seen.google.length = 0;
  const r = await call('route_options', { start: { lat: A[1], lng: A[0], name: 'Red Lodge' }, stops: [{ lat: 45.1, lng: -109.6, name: 'Roscoe', kind: 'fuel' }], end: { lat: B[1], lng: B[0], name: 'Cooke City' }, avoidTolls: true, traffic: true });
  const sc = r.result?.structuredContent;
  check('avoid-tolls rides into every Valhalla request', seen.valhalla.every((b) => b.costing_options.motorcycle.use_tolls === 0));
  check('the stop rides as break_through', seen.valhalla.every((b) => b.locations[1].type === 'break_through'));
  check('with a stop, alternates are not asked for', seen.valhalla.every((b) => !b.alternates));
  check('the traffic quote is a corridor figure, not pinned', sc.options.every((o) => o.traffic && o.traffic.pinned === false) && seen.google.every((b) => b.routeModifiers?.avoidTolls === true));
  check('no toll price when tolls are avoided', sc.options.every((o) => !o.toll));
  check('no future departure → traffic now', sc.options.every((o) => o.traffic.at === null) && sc.departureTime === null);
}

console.log('save the pick:');
let tripId;
{
  const alt = options.find((o) => o.kind === 'alternate') ?? options[0];
  const r = await call('save_route_option', { optionSetId, optionId: alt.id, name: 'Beartooth Saturday' });
  const sc = r.result?.structuredContent;
  check('saves without error', r.result && !r.result.isError, JSON.stringify(r).slice(0, 300));
  tripId = sc?.trip?.tripId;
  check('a tripId and an app link come back', typeof tripId === 'string' && sc.trip.url === `https://roadbook-app.netlify.app/#trip=${encodeURIComponent(tripId)}`, sc?.trip?.url);
  const row = db.tables.user_trips.find((x) => x.trip_id === tripId);
  check('the row is a user_trips record the app can pull', row && row.user_id === 'rider-1' && row.name === 'Beartooth Saturday' && Array.isArray(row.scenarios) && row.deleted_at === null && row.updated_at);
  const trip = row?.trip;
  check('the trip carries the option\'s route character', trip?.meta?.routePrefs?.style === alt.prefs.style && trip.meta.routePrefs.avoidTolls === false, JSON.stringify(trip?.meta?.routePrefs));
  check('dated from the departure, dow cascaded', trip?.days?.[0]?.date === '2027-07-10' && trip.days[0].dow === 'Sat' && /9:00/.test(trip.days[0].depart), `${trip?.days?.[0]?.date} ${trip?.days?.[0]?.dow} ${trip?.days?.[0]?.depart}`);
  const wps = trip?.days?.[0]?.waypoints ?? [];
  check('start and end are the resolved places, the end verified by its place id', wps[0]?.kind === 'start' && wps[wps.length - 1]?.kind === 'end' && wps[wps.length - 1].placeId === 'pl_Cooke_City_MT' && wps[wps.length - 1].verified === 'google');
  if (alt.kind === 'alternate') {
    const vias = wps.filter((w) => w.kind === 'via');
    check('an alternate road is pinned with placed pass-through vias', vias.length >= 3 && vias.every((w) => w.placed === 'ai' && /^Via \d/.test(w.name)), `${vias.length} vias`);
  }
  check('every waypoint has an id the ops vocabulary can address', wps.every((w) => typeof w.id === 'string' && w.id.startsWith('wp')));
  check('the trip is stamped as connector-made', trip?.meta?.origin === 'mcp');
  check('structured content feeds the trip app', sc?.stops?.[0]?.waypoints?.length === wps.length && sc.geometry?.[trip.days[0].id]?.length > 0);
  const gone = await call('save_route_option', { optionSetId: 'opt_nope', optionId: alt.id });
  check('an unknown option set is refused', gone.result?.isError === true);
}

console.log('the library:');
{
  const l = await call('list_trips');
  check('list_trips shows the saved trip', l.result?.structuredContent?.trips?.some((t) => t.tripId === tripId) && /Beartooth Saturday/.test(l.result.content[0].text));
  const g = await call('get_trip', { tripId, measure: true });
  const sc = g.result?.structuredContent;
  check('get_trip returns ids for every stop', sc?.stops?.[0]?.waypoints?.every((w) => w.id && w.name));
  check('measure=true routes the day on real roads', sc?.trip?.dayList?.[0]?.roadMiles > 0 && sc.trip.dayList[0].ridingMinutes > 0 && sc.geometry && Object.keys(sc.geometry).length === 1, JSON.stringify(sc?.trip?.dayList?.[0]));
  check('the first measure routed the day and says so', sc.measure?.routed === 1 && sc.measure.complete === true, JSON.stringify(sc?.measure));
  const before = seen.valhalla.length;
  const g2 = await call('get_trip', { tripId, measure: true });
  check('a second measure comes from the cache — no router call, still complete', seen.valhalla.length === before && g2.result.structuredContent.measure.cached === 1 && g2.result.structuredContent.measure.routed === 0 && g2.result.structuredContent.measure.complete === true, JSON.stringify(g2.result?.structuredContent?.measure));
  const dayId = sc.trip.dayList[0].id;
  const u = await call('update_trip', { tripId, ops: [
    { op: 'add_waypoint', dayId, index: 1, waypoint: { name: 'Town Pump Red Lodge', lat: 45.18, lng: -109.3, kind: 'fuel', fuel: true } },
    { op: 'set_day_field', dayId, field: 'summary', value: 'Fuel in Red Lodge, then the pass.' },
    { op: 'remove_waypoint', dayId: 'day-nope', waypointId: 'x' },
  ] });
  const us = u.result?.structuredContent;
  check('update_trip applies the ops it can and reports the one it cannot', us?.applied?.length === 3 && us.errors.length === 1 && /unknown day/.test(us.errors[0]), JSON.stringify(us?.errors));
  check('the place check is reported to the model', /Place check/.test(u.result.content[0].text) && /Town Pump/.test(u.result.content[0].text));
  const row = db.tables.user_trips.find((x) => x.trip_id === tripId);
  const wps = row.trip.days[0].waypoints;
  check('the fuel stop is in the day, in position, flagged fuel', wps[1]?.name === 'Town Pump Red Lodge' && wps[1].kind === 'fuel' && wps[1].fuel === true);
  check('the summary is stamped against the route it describes', row.trip.days[0].summary === 'Fuel in Red Lodge, then the pass.' && typeof row.trip.days[0].summaryFor === 'string');
  const x = await call('export_gpx', { tripId });
  const res = x.result?.content?.find((c) => c.type === 'resource');
  check('export_gpx returns a GPX resource with ETAs in the names', res?.resource?.mimeType === 'application/gpx+xml' && /^<\?xml/.test(res.resource.text) && /ETA/.test(res.resource.text) && /<trkpt/.test(res.resource.text));
}

console.log('a multi-day itinerary:');
{
  const r = await call('create_trip', {
    name: 'Missoula to Sturgis', startDate: '2027-08-06', riders: 3, routePrefs: { style: 'backroads', avoidTolls: true }, phaseLabels: { rally: 'Rally' },
    days: [
      { title: 'Missoula → Bozeman', depart: '8:00 AM', phase: 'outbound', waypoints: [{ name: 'Missoula, MT', lat: 46.87, lng: -113.99 }, { name: 'Town Pump, Deer Lodge', lat: 46.39, lng: -112.73, kind: 'fuel' }, { name: 'Bozeman, MT', lat: 45.68, lng: -111.04 }], lodging: { status: 'reserve', name: 'Lewis & Clark Motel', where: 'Bozeman' }, meals: [{ meal: 'dinner', name: 'Montana Ale Works' }] },
      { title: 'Bozeman → Red Lodge', waypoints: [{ name: 'Bozeman, MT', lat: 45.68, lng: -111.04 }, { name: 'Beartooth Pass', lat: 44.97, lng: -109.47, kind: 'photo', placed: 'ai' }, { name: 'Red Lodge, MT', lat: 45.19, lng: -109.25 }], gates: [{ label: 'Pass gate closes', by: '6:00 PM', waypointIndex: 1 }] },
    ],
  });
  const sc = r.result?.structuredContent;
  check('creates without error', r.result && !r.result.isError, JSON.stringify(r).slice(0, 300));
  const row = db.tables.user_trips.find((x) => x.trip_id === sc?.trip?.tripId);
  check('two days, dates cascaded from the start', row?.trip?.days?.length === 2 && row.trip.days[1].date === '2027-08-07' && row.trip.days[1].dow === 'Sat');
  check('endpoint kinds normalised, fuel kept, the pass placed', row.trip.days[0].waypoints[0].kind === 'start' && row.trip.days[0].waypoints[2].kind === 'end' && row.trip.days[0].waypoints[1].fuel === true && row.trip.days[1].waypoints[1].placed === 'ai');
  check('lodging, meals and a gate pointed at a real stop', row.trip.days[0].lodging.status === 'reserve' && row.trip.days[0].meals[0].meal === 'dinner' && row.trip.days[1].gates[0].waypointId === row.trip.days[1].waypoints[1].id);
  check('the rider\'s road character, riders and phase words are on the trip', row.trip.meta.routePrefs.style === 'backroads' && row.trip.meta.routePrefs.avoidTolls === true && row.trip.meta.riders === 3 && row.trip.meta.phaseLabels.rally === 'Rally');
  check('the place check ran and is reported', /Place check/.test(r.result.content[0].text));
  check('a long trip is verified in passes — the answer says what is left and names verify_trip', /not yet checked/.test(r.result.content[0].text) && /verify_trip/.test(r.result.content[0].text), r.result.content[0].text.slice(-200));
  const v1 = await call('verify_trip', { tripId: sc.trip.tripId });
  const s1 = v1.result?.structuredContent;
  check('verify_trip checks a batch and reports the remainder', s1 && s1.checked === 2 && s1.remaining > 0 && s1.complete === false && s1.before === s1.remaining + 2, JSON.stringify(s1));
  let last = s1;
  for (let i = 0; i < 6 && last && !last.complete; i++) last = (await call('verify_trip', { tripId: sc.trip.tripId })).result?.structuredContent;
  check('called again until nothing is left, it completes', last?.complete === true && last.remaining === 0, JSON.stringify(last));
  const wpsNow = db.tables.user_trips.find((x) => x.trip_id === sc.trip.tripId).trip.days.flatMap((d) => d.waypoints);
  check('every checkable stop is now verified on the saved trip', wpsNow.filter((w) => !w.placed).every((w) => w.verified === 'google' && w.placeId));
  // the budget is read from the environment per call: a 1 ms budget routes nothing
  const t3 = await call('create_trip', { name: 'Budget test', startDate: '2027-09-01', days: [
    { title: 'A', waypoints: [{ name: 'P', lat: A[1], lng: A[0], placeId: 'p1' }, { name: 'Q', lat: B[1], lng: B[0], placeId: 'p2' }] },
    { title: 'B', waypoints: [{ name: 'Q', lat: B[1], lng: B[0], placeId: 'p2' }, { name: 'R', lat: 45.5, lng: -110.5, placeId: 'p3' }] },
  ] });
  const t3id = t3.result.structuredContent.trip.tripId;
  // the mocked router answers instantly, so a budget already in the past is
  // the only way to prove the deadline is honoured
  process.env.MCP_TOOL_BUDGET_MS = '-100000';
  const b1 = await call('get_trip', { tripId: t3id, measure: true });
  const bm = b1.result.structuredContent.measure;
  check('MCP_TOOL_BUDGET_MS bounds a call: an exhausted budget routes nothing and points at the next day', bm.routed === 0 && bm.complete === false && bm.nextDayId === t3.result.structuredContent.trip.dayList[0].id, JSON.stringify(bm));
  delete process.env.MCP_TOOL_BUDGET_MS;
  const b2 = await call('get_trip', { tripId: t3id, measure: true, fromDayId: t3.result.structuredContent.trip.dayList[1].id });
  const bm2 = b2.result.structuredContent.measure;
  check('fromDayId starts routing at that day and leaves the earlier one for later', bm2.routed === 1 && bm2.complete === false && bm2.nextDayId === t3.result.structuredContent.trip.dayList[0].id, JSON.stringify(bm2));
  const b3 = await call('get_trip', { tripId: t3id, measure: true });
  check('the next pass fills the gap from cache plus one route and completes', b3.result.structuredContent.measure.complete === true && b3.result.structuredContent.measure.cached === 1 && b3.result.structuredContent.measure.routed === 1, JSON.stringify(b3.result.structuredContent.measure));
  const gx = await call('export_gpx', { tripId: t3id });
  check('export_gpx then rides entirely on cached roads', gx.result.structuredContent.routedDays === 2 && gx.result.structuredContent.complete === true);
  const d = await call('delete_trip', { tripId: sc.trip.tripId });
  check('delete tombstones the row (the app\'s own soft delete)', d.result?.structuredContent?.deleted === true && db.tables.user_trips.find((x) => x.trip_id === sc.trip.tripId).deleted_at);
  const g = await call('get_trip', { tripId: sc.trip.tripId });
  check('a deleted trip is gone from reads', g.result?.isError === true);
  const l = await call('list_trips');
  check('and from the list', !l.result.structuredContent.trips.some((t) => t.tripId === sc.trip.tripId));
}

console.log('places and concepts:');
{
  seen.places.length = 0;
  const r = await call('search_places', { category: 'fuel', alongOptionSetId: optionSetId });
  check('search along a measured road sends Google the road', seen.places[0]?.searchAlongRouteParameters?.polyline?.encodedPolyline?.length > 10 && seen.places[0].includedType === 'gas_station');
  check('rows carry placeId and the along-route figure', r.result?.structuredContent?.places?.[0]?.placeId && r.result.structuredContent.places[0].alongRouteMiles === 18.6, JSON.stringify(r.result?.structuredContent?.places?.[0]).slice(0, 200));
  const n = await call('search_places', { query: 'Town Pump', near: { lat: 45.19, lng: -109.25 } });
  check('a name search near a point works', /Town Pump/.test(n.result?.content?.[0]?.text ?? ''));
  const e = await call('evaluate_trip_concept', { concepts: [{ id: 'c1', title: 'Direct', locations: [{ name: 'A', lat: A[1], lng: A[0], kind: 'start' }, { name: 'B', lat: B[1], lng: B[0], kind: 'end' }] }, { id: 'c2', title: 'Scenic', locations: [{ name: 'A', lat: A[1], lng: A[0], kind: 'start' }, { name: 'Roscoe', lat: 45.1, lng: -109.6, kind: 'fuel' }, { name: 'B', lat: B[1], lng: B[0], kind: 'end' }] }], routePrefs: { style: 'touring' } });
  check('concepts are measured with a baseline and deltas', e.result?.structuredContent?.options?.length === 2 && e.result.structuredContent.baselineId && e.result.structuredContent.options.every((o) => o.metrics && Number.isFinite(o.metrics.deltaMinutes) && !('searchPolyline' in o)), JSON.stringify(e.result).slice(0, 300));
  const t = await call('traffic_eta', { start: { lat: A[1], lng: A[0] }, end: { lat: B[1], lng: B[0] }, departureTime: '2027-07-10T21:00:00Z' });
  check('traffic_eta quotes minutes and a toll for a future departure', t.result?.structuredContent?.minutes === 130 && t.result.structuredContent.toll?.amount === 7.5 && t.result.structuredContent.departureTime === '2027-07-10T21:00:00Z');
}

console.log('auth:');
{
  const config = { url: 'https://proj.supabase.co', key: 'pk', service: 'service', configured: true };
  const reqWith = (auth) => new Request('http://localhost/mcp', { method: 'POST', headers: auth ? { authorization: auth } : {} });
  await authenticate(reqWith(null), { config }).then(() => check('no bearer → 401', false), (e) => check('no bearer → 401', e instanceof AuthError && e.status === 401));
  const token = mintToken();
  const tokdb = fakeDb();
  tokdb.tables.mcp_tokens.push({ id: 't1', user_id: 'rider-9', token_hash: hashToken(token), revoked_at: null });
  const s = await authenticate(reqWith(`Bearer ${token}`), { config, clients: { service: tokdb } });
  check('a connector token resolves by hash to its rider', s.userId === 'rider-9' && s.via === 'token' && s.db === tokdb);
  check('only the hash is compared (the plain token is never stored)', !JSON.stringify(tokdb.tables.mcp_tokens).includes(token) && token.startsWith('rbk_') && token.length > 40);
  tokdb.tables.mcp_tokens[0].revoked_at = '2026-09-20T00:00:00Z';
  await authenticate(reqWith(`Bearer ${token}`), { config, clients: { service: tokdb } }).then(() => check('a revoked token is refused', false), (e) => check('a revoked token is refused', e.status === 401));
  await authenticate(reqWith(`Bearer ${token}`), { config: { ...config, service: '' }, clients: {} }).then(() => check('a token needs the service key', false), (e) => check('a token needs the service key', e.status === 401 && /OAuth/.test(e.message)));
  const userClient = (user) => ({ auth: { getUser: async () => ({ data: { user }, error: null }) } });
  const j = await authenticate(reqWith('Bearer eyJ.jwt'), { config: { ...config, service: '' }, clients: { user: userClient({ id: 'rider-2', email: 'a@b.c', is_anonymous: false, user_metadata: { name: 'Al' } }) } });
  check('a Supabase access token resolves through auth.getUser and, with no service key, acts through that JWT (RLS)', j.userId === 'rider-2' && j.via === 'oauth' && j.name === 'Al' && typeof j.db.auth.getUser === 'function');
  await authenticate(reqWith('Bearer eyJ.anon'), { config, clients: { user: userClient({ id: 'anon-1', is_anonymous: true }) } }).then(() => check('an anonymous crew session is refused', false), (e) => check('an anonymous crew session is refused', e.status === 401 && /join code/.test(e.message)));
  const meta = protectedResourceMetadata('https://roadbook-app.netlify.app/mcp', config);
  check('resource metadata points at Supabase Auth as the authorization server', meta.resource === 'https://roadbook-app.netlify.app/mcp' && meta.authorization_servers[0] === 'https://proj.supabase.co/auth/v1' && meta.bearer_methods_supported.includes('header'));
  const hdr = wwwAuthenticate('https://roadbook-app.netlify.app/.well-known/oauth-protected-resource', new AuthError('Sign in'));
  check('WWW-Authenticate names the metadata document', /^Bearer resource_metadata="https:\/\/roadbook-app\.netlify\.app\/\.well-known\/oauth-protected-resource"/.test(hdr) && /error="invalid_token"/.test(hdr));
}

console.log('the functions:');
{
  process.env.SUPABASE_URL ||= 'https://proj.supabase.co';
  process.env.SUPABASE_KEY ||= 'pk';
  const o = await mcpFunction(new Request('https://roadbook-app.netlify.app/mcp', { method: 'OPTIONS' }));
  check('CORS preflight is answered', o.status === 204 && /Authorization/.test(o.headers.get('access-control-allow-headers')));
  const h = await mcpFunction(new Request('https://roadbook-app.netlify.app/mcp', { headers: { accept: 'text/html' } }));
  const hj = await h.json();
  check('a browser visit gets a signpost, not an error', h.status === 200 && hj.endpoint === 'https://roadbook-app.netlify.app/mcp' && /oauth-protected-resource/.test(hj.auth.resource_metadata));
  const u = await mcpFunction(new Request('https://roadbook-app.netlify.app/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}' }));
  check('an unauthenticated POST is 401 with WWW-Authenticate', u.status === 401 && /resource_metadata="https:\/\/roadbook-app\.netlify\.app\/\.well-known\/oauth-protected-resource"/.test(u.headers.get('www-authenticate') ?? '') && u.headers.get('access-control-allow-origin') === '*', `${u.status} ${u.headers.get('www-authenticate')}`);
  const m = await metadataFunction(new Request('https://roadbook-app.netlify.app/.well-known/oauth-protected-resource'));
  const mj = await m.json();
  check('the discovery document is served', m.status === 200 && mj.resource === 'https://roadbook-app.netlify.app/mcp' && mj.authorization_servers?.[0] === 'https://proj.supabase.co/auth/v1', JSON.stringify(mj));
}

console.log('isolation:');
{
  _resetMemStore();
  const other = { ...session, userId: 'rider-2' };
  const req = new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'list_trips', arguments: {} } }) });
  const res = await handleMcpRequest(req, other, { deps });
  const j = JSON.parse(await res.text());
  check('another rider sees none of these trips', j.result?.structuredContent?.trips?.length === 0, JSON.stringify(j).slice(0, 200));
  const srv = buildServer(session, deps);
  check('buildServer returns a server per request', typeof srv.connect === 'function');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

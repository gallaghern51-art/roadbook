// The Roadbook MCP server: what a rider's OWN AI can do with their roadbook.
//
// Riders already ask the AI they carry — Claude, ChatGPT, whatever is on the
// phone — where they should go. This server lets that conversation end in a
// trip in THEIR Roadbook library instead of a paragraph: the model measures
// the roads with the app's own router (Valhalla motorcycle costing, every
// style, plus alternates), quotes the clock and the tolls from Google, shows
// the choice as an interactive picker (an MCP App), and saves the one the
// rider taps as a real trip document — the same shape the app plans, grades,
// exports and rides.
//
// Design rules, in order:
//   1. The MODEL plans, the SERVER measures and writes. No tool here calls a
//      language model; the facts come from the routers and Places, and the
//      choice stays the rider's.
//   2. Every write goes through the app's own vocabulary — the trip document
//      builders and the op reducer in src/engine — so nothing a connector
//      saves can be a shape the app does not already read.
//   3. Every AI-authored stop is verified against Places (or marked placed /
//      unverified) exactly as the in-app planner's are. A recalled gas
//      station is the worst class of wrong.
//   4. One request, one server: Netlify functions are stateless, so each
//      call builds a McpServer bound to the authenticated rider and answers
//      in JSON (no sessions, no SSE resumption). Tools stay inside the host's
//      10-second budget by measuring in order and stopping at a deadline.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

import { valhallaTrips } from '../../src/engine/routing.js';
import { tripToGpx } from '../../src/engine/exporters.js';
import { tripPace, tripRoutePrefs, routeFingerprint, routePrefsKey, DEFAULT_RANGE } from '../../src/engine/tripEngine.js';
import { createHash } from 'node:crypto';
import { TOOL as CHAT_TOOL } from './planner-core.mjs';
import { evaluateRouteOptions } from './route-opportunities.mjs';
import { verifyTrip, verifyProposal, describeVerification, planVerification } from './verify-places.mjs';
import { searchPlacesGoogle } from './places-core.mjs';
import { computeRoute, isFutureIso } from './google-routes.mjs';
import { measureOptions, resolvePlace, describeOptions, departureIso, STYLE_IDS } from './mcp-routes.mjs';
import { putOptionSet, getOptionSet, putDayRoute, getDayRoute } from './mcp-store.mjs';
import {
  listTrips, getTripRow, saveTrip, tombstoneTrip, tripFromOption, tripFromDays, tripSummary, tripStops, applyTripOps, newTripId, tripUrl, APP_URL, fmtMin,
} from './mcp-library.mjs';
import { UI, UI_META } from './mcp-ui.mjs';

export const SERVER_INFO = { name: 'roadbook', version: '1.0.0' };
export const INSTRUCTIONS = `Roadbook is a motorcycle trip planner. You are talking to a rider's own library.
Typical flow: search_places to pin down real places → route_options to measure every road worth riding between them (shows a picker the rider can tap) → save_route_option when they choose, or create_trip for a multi-day itinerary you authored → get_trip / update_trip to read and edit. Miles and minutes come from Valhalla motorcycle costing; traffic and tolls from Google for the departure you name. Never invent a gas station, hotel or restaurant — search_places first; anything you add without a place id is verified after the fact and flagged if it does not exist.`;

// ---------------------------------------------------------------- helpers ----

const text = (t) => ({ type: 'text', text: t });
const ok = (t, structuredContent) => ({ content: [text(t)], ...(structuredContent ? { structuredContent } : {}) });
const fail = (t) => ({ content: [text(t)], isError: true });
const uiMeta = (uri) => ({ 'ui/resourceUri': uri, ui: { resourceUri: uri } });
const sessionOf = (extra) => extra?.authInfo?.extra?.session ?? null;

const CATEGORY = {
  fuel: { type: 'gas_station', query: 'gas station' },
  food: { type: 'restaurant', query: 'restaurant' },
  coffee: { type: 'cafe', query: 'coffee' },
  lodging: { type: 'lodging', query: 'motel hotel lodging' },
  sights: { type: 'tourist_attraction', query: 'scenic viewpoint attraction' },
  moto: { type: null, query: 'motorcycle repair shop dealer' },
  help: { type: 'hospital', query: 'hospital urgent care' },
};

// Precision-5 encoder (Google's format; Valhalla's is precision 6).
function encodePolyline5(coords) {
  let out = ''; let plat = 0; let plng = 0;
  const enc = (v) => {
    let s = '';
    v = v < 0 ? ~(v << 1) : (v << 1);
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lng, lat] of coords) {
    const ilat = Math.round(lat * 1e5); const ilng = Math.round(lng * 1e5);
    out += enc(ilat - plat) + enc(ilng - plng);
    plat = ilat; plng = ilng;
  }
  return out;
}

const Point = z.object({
  lat: z.number(), lng: z.number(),
  name: z.string().optional(),
  placeId: z.string().optional().describe('from search_places — carry it so the stop is a verified listing'),
  kind: z.enum(['via', 'fuel', 'photo']).optional(),
  dwell: z.number().optional().describe('minutes stopped, if not the default'),
});
// A place as the model names it: coordinates, or a name to resolve through Places.
const PlaceIn = z.union([Point, z.string().min(1)]).describe('{lat,lng,name?,placeId?} or a place name like "Red Lodge, MT"');

// How long one tool call may spend measuring or verifying. Netlify's
// synchronous functions die at 10 s, so the default leaves room for the
// library read and the answer; on a host with longer functions (Vercel) raise
// it in the environment and every tool measures more per call.
export const budgetMs = () => Number(process.env.MCP_TOOL_BUDGET_MS) || 6500;

// Route the days of a trip on real roads — in order, RESUMABLY. A day already
// routed (same stops, same road character) comes from the per-trip cache for
// free, and the call routes what is still missing until its deadline. So a
// 30-day trip is measured in passes: call again, and it continues where it
// stopped; `nextDayId` says where that is, `complete` says when it is done.
const dayRouteKey = (day, prefs) => createHash('sha256').update(`${routeFingerprint(day)}|${routePrefsKey(prefs)}`).digest('hex').slice(0, 24);

async function measureDays(trip, { deadline, tripId = null, fromDayId = null }) {
  const prefs = tripRoutePrefs(trip);
  const pace = tripPace(trip);
  const out = {};
  const geometry = {};
  let cached = 0; let routed = 0; let nextDayId = null;
  const days = trip.days ?? [];
  const startAt = fromDayId ? Math.max(0, days.findIndex((d) => d.id === fromDayId)) : 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const wps = (day.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng));
    if (wps.length < 2) continue;
    const key = tripId ? dayRouteKey(day, prefs) : null;
    const hit = key ? await getDayRoute(tripId, key) : null;
    if (hit) {
      out[day.id] = { miles: hit.miles, minutes: hit.minutes * pace };
      geometry[day.id] = hit.geometry;
      cached += 1;
      continue;
    }
    // a day skipped by fromDayId is still owed — name it as the next one
    if (i < startAt) { nextDayId ??= day.id; continue; }
    if (Date.now() > deadline) { nextDayId ??= day.id; continue; }
    try {
      const [t] = await valhallaTrips(wps[0], wps.slice(1), prefs, { alternates: 0 });
      out[day.id] = { miles: t.miles, minutes: t.minutes * pace };
      geometry[day.id] = t.geometry;
      routed += 1;
      if (key) await putDayRoute(tripId, key, { miles: t.miles, minutes: t.minutes, geometry: thin(t.geometry, 600) }).catch(() => {});
    } catch { nextDayId ??= day.id; /* this day stays unmeasured; the summary says so */ }
  }
  const total = days.filter((d) => (d.waypoints ?? []).filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lng)).length >= 2).length;
  return { measured: out, geometry, cached, routed, nextDayId, complete: Object.keys(out).length >= total };
}

const measureNote = (m) => (m.complete
  ? `All ${Object.keys(m.measured).length} days are routed on real roads.`
  : `${Object.keys(m.measured).length} day${Object.keys(m.measured).length === 1 ? '' : 's'} routed so far (${m.routed} this call, ${m.cached} from cache); call again to continue from dayId ${m.nextDayId} — routed days are cached, so each pass adds to the last.`);

// Stops a verification pass has not reached yet — neither verified nor judged.
const unverifiedLeft = (trip) => planVerification(structuredClone(trip), { retryUnverified: false }).length;

// The clock and the date as WRITTEN in an ISO string — never re-read through
// Date, which would shift them into this process's zone.
const wallClock = (iso) => {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};
const wallDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso ?? '')) ? String(iso).slice(0, 10) : null);

const thin = (g, max = 250) => {
  if (!Array.isArray(g) || g.length <= max) return g;
  const step = (g.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => g[Math.round(i * step)]);
};

// ------------------------------------------------------------- the server ----

/**
 * @param {object} session  from mcp-auth authenticate(): { userId, email, name, db }
 * @param {object} [deps]   test seams
 */
export function buildServer(session, deps = {}) {
  const {
    googleKey = process.env.GOOGLE_MAPS_API_KEY,
    searchImpl = searchPlacesGoogle,
    routeImpl, // routeOptions
    googleImpl = computeRoute,
    evaluateImpl = evaluateRouteOptions,
    measureDaysImpl = measureDays,
    verifyTripImpl = verifyTrip,
    verifyProposalImpl = verifyProposal,
    now = () => Date.now(),
  } = deps;
  const { db, userId } = session;

  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  // ---- places ----
  server.registerTool('search_places', {
    title: 'Search places',
    description: 'Find real, verified places (Google Places): gas stations, restaurants, lodging, cafés, sights, motorcycle shops, hospitals, or anything by name. Results carry a placeId — pass it into route_options / create_trip so the stop is a verified listing. Search near a point, or along a measured route option (fuel and food ON the road, with the detour each one costs).',
    inputSchema: {
      query: z.string().optional().describe('free text, e.g. "Town Pump Billings" or "BBQ"; optional when category is given'),
      category: z.enum(['fuel', 'food', 'coffee', 'lodging', 'sights', 'moto', 'help']).optional(),
      near: z.object({ lat: z.number(), lng: z.number() }).optional().describe('bias centre; required unless alongOptionSetId is given'),
      radiusMi: z.number().min(1).max(150).optional().describe('default 25'),
      alongOptionSetId: z.string().optional().describe('an optionSetId from route_options — search along that road'),
      alongOptionId: z.string().optional().describe('which option in the set; default the first'),
      limit: z.number().int().min(1).max(10).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    if (!googleKey) return fail('Place search is not configured on this server (GOOGLE_MAPS_API_KEY).');
    const cat = args.category ? CATEGORY[args.category] : null;
    const q = String(args.query ?? '').trim();
    if (!cat && q.length < 2) return fail('Give a query or a category.');
    let route = null; let near = args.near ?? null;
    if (args.alongOptionSetId) {
      const set = await getOptionSet(userId, args.alongOptionSetId);
      if (!set) return fail('That route option set has expired or is not yours — run route_options again.');
      const opt = set.options.find((o) => o.id === args.alongOptionId) ?? set.options[0];
      route = opt?.geometry ?? null;
      near = near ?? set.start;
    }
    if (!near) return fail('Give near {lat,lng} or an alongOptionSetId.');
    try {
      const places = await searchImpl(googleKey, q || cat.query, near, {
        limit: Math.min(10, args.limit ?? 8),
        hours: true,
        enrich: true,
        type: cat?.type ?? null,
        radiusM: Math.min(150_000, Math.max(1000, (args.radiusMi ?? 25) * 1609.34)),
        encodedPolyline: route ? encodePolyline5(thin(route, 400)) : null,
      });
      let open = places.filter((p) => p.status !== 'CLOSED_PERMANENTLY');
      if (args.category === 'moto') open = open.filter((p) => /motor|cycle|moto|powersport|twin|harley|indian|bmw|ducati|triumph|honda|yamaha|kawasaki|suzuki|ktm|bike/i.test(p.name ?? '') || (p.types ?? []).includes('car_repair'));
      const rows = open.map((p) => ({
        placeId: p.id, name: p.name, address: p.detail, lat: p.lat, lng: p.lng,
        type: p.primaryType || null, rating: p.rating ?? null, ratingCount: p.userRatingCount ?? null, price: p.priceLevel ?? null,
        openNow: p.openNow, hours: p.hours ?? null, phone: p.phone ?? null, website: p.websiteUri ?? null,
        ...(p.routeDistanceMeters ? { alongRouteMiles: Math.round((p.routeDistanceMeters / 1609.34) * 10) / 10, alongRouteMinutes: Math.round((p.routeDurationSeconds ?? 0) / 60) } : {}),
      }));
      const lines = rows.map((r) => `• ${r.name}${r.rating ? ` ★${r.rating} (${r.ratingCount})` : ''}${r.openNow === false ? ' · closed now' : ''}${r.alongRouteMiles != null ? ` · ${r.alongRouteMiles} mi along the road` : ''} — ${r.address} [placeId ${r.placeId}]`);
      return ok(rows.length ? lines.join('\n') : 'No places found.', { places: rows, attribution: 'Place facts from Google' });
    } catch (e) {
      return fail(`Place search failed: ${String(e.message).slice(0, 200)}`);
    }
  });

  // ---- roads ----
  server.registerTool('route_options', {
    title: 'Route options',
    description: 'Measure every road worth riding between a start and a destination (optionally through stops): Quick / Touring / Back roads by Valhalla motorcycle costing, plus the router\'s own alternates, merged into one honest list with miles, road time, predicted traffic time for the departure, toll flags and an estimated toll price. Renders an interactive picker; the rider can tap one and save it. Returns an optionSetId — pass it to save_route_option.',
    inputSchema: {
      start: PlaceIn,
      end: PlaceIn,
      stops: z.array(PlaceIn).max(8).optional().describe('intermediate stops in road order (alternates are only offered for a ride with no stops)'),
      avoidTolls: z.boolean().optional(),
      styles: z.array(z.enum(['quick', 'touring', 'backroads'])).optional().describe('default all three'),
      prefer: z.enum(['quick', 'touring', 'backroads']).optional().describe('the rider\'s usual road character — leads the list and breaks ties'),
      departureTime: z.string().optional().describe('ISO datetime; a FUTURE departure gets predicted traffic for that moment, otherwise traffic now'),
      date: z.string().optional().describe('YYYY-MM-DD ride date (alternative to departureTime, with time)'),
      time: z.string().optional().describe('e.g. "9:00 AM", with date'),
      traffic: z.boolean().optional().describe('default true; false skips Google (no traffic, no toll price)'),
      pace: z.number().optional().describe('group-pace multiplier, default 1.08'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: uiMeta('ui://roadbook/route-options'),
  }, async (args) => {
    try {
      const start = await resolvePlace(googleKey, args.start, { searchImpl });
      const end = await resolvePlace(googleKey, args.end, { near: start, searchImpl });
      const stops = [];
      for (const s of args.stops ?? []) stops.push(await resolvePlace(googleKey, s, { near: start, searchImpl }));
      const departureTime = args.departureTime ?? departureIso(args.date, args.time);
      const set = { start, stops, end, avoidTolls: !!args.avoidTolls };
      const result = await measureOptions({
        ...set,
        styles: (args.styles?.length ? args.styles : STYLE_IDS),
        prefer: args.prefer ?? null,
        pace: args.pace ?? 1.08,
        departureTime,
        traffic: args.traffic !== false,
        googleKey,
        ...(routeImpl ? { routeImpl } : {}),
        googleImpl,
      });
      // The wall clock the rider actually said ("9:00 AM on the 10th") is
      // kept beside the instant: a saved day wants the clock as written, not
      // the instant re-read in whatever zone this server happens to run in.
      const optionSetId = await putOptionSet(userId, { ...set, options: result.options, departureTime: result.at, date: args.date ?? wallDate(departureTime), time: args.time ?? wallClock(departureTime) });
      const suggestedDate = args.date ?? (result.at ? result.at.slice(0, 10) : null);
      const body = describeOptions(set, result);
      return ok(
        `${body}\noptionSetId: ${optionSetId} — call save_route_option with an optionId to make one a trip, or search_places with alongOptionSetId for fuel and food on that road.`,
        { optionSetId, ...set, departureTime: result.at, suggestedDate, options: result.options, notes: result.notes },
      );
    } catch (e) {
      return fail(`Could not measure these roads: ${String(e.message).slice(0, 200)}`);
    }
  });

  server.registerTool('save_route_option', {
    title: 'Save a route option as a trip',
    description: 'Turn one measured option from route_options into a one-day trip in the rider\'s Roadbook library, with the road character it was measured under (an alternate road is pinned with pass-through points). Returns the trip and a link that opens it in the app.',
    inputSchema: {
      optionSetId: z.string(),
      optionId: z.string(),
      name: z.string().optional().describe('trip title; default "Start → Destination"'),
      date: z.string().optional().describe('YYYY-MM-DD; default the departure date, else today'),
      depart: z.string().optional().describe('e.g. "9:00 AM"'),
      riders: z.number().int().min(1).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: uiMeta('ui://roadbook/trip'),
  }, async (args) => {
    const set = await getOptionSet(userId, args.optionSetId);
    if (!set) return fail('That route option set has expired or is not yours — run route_options again.');
    const option = set.options.find((o) => o.id === args.optionId);
    if (!option) return fail(`No option ${args.optionId} in that set. Options: ${set.options.map((o) => o.id).join(', ')}.`);
    const depart = args.depart ?? set.time ?? '9:00 AM';
    const date = args.date ?? set.date ?? undefined;
    const trip = tripFromOption(set, option, { name: args.name, date, depart, riders: args.riders });
    const tripId = newTripId();
    const row = await saveTrip(db, userId, { tripId, name: trip.meta.title, trip });
    const summary = tripSummary(row);
    return ok(
      `Saved "${trip.meta.title}" (${option.label}${option.via ? ` via ${option.via}` : ''}, ${option.miles} mi, ${fmtMin(option.minutes)}) for ${trip.days[0].date}, leaving ${depart}. tripId ${tripId}. Open it: ${tripUrl(tripId)}`,
      { trip: summary, stops: tripStops(trip), geometry: { [trip.days[0].id]: option.geometry } },
    );
  });

  server.registerTool('traffic_eta', {
    title: 'Traffic time for a corridor',
    description: 'Google\'s traffic-aware time between two points (through optional stops) for a departure — predicted traffic for a future departure, live traffic now — plus an estimated toll price. Use it to compare leaving times; route_options already includes this per road.',
    inputSchema: {
      start: PlaceIn, end: PlaceIn,
      stops: z.array(PlaceIn).max(8).optional(),
      departureTime: z.string().optional().describe('ISO; future → predicted'),
      avoidTolls: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    if (!googleKey) return fail('Traffic is not configured on this server (GOOGLE_MAPS_API_KEY).');
    try {
      const start = await resolvePlace(googleKey, args.start, { searchImpl });
      const end = await resolvePlace(googleKey, args.end, { near: start, searchImpl });
      const stops = [];
      for (const s of args.stops ?? []) stops.push(await resolvePlace(googleKey, s, { near: start, searchImpl }));
      const future = isFutureIso(args.departureTime);
      const g = await googleImpl(googleKey, { origin: start, waypoints: [...stops, end], avoidTolls: !!args.avoidTolls, tolls: true, ...(future ? { departureTime: args.departureTime } : {}) });
      const minutes = Math.round(g.durationSeconds / 60);
      const miles = Math.round((g.distanceMeters / 1609.34) * 10) / 10;
      return ok(
        `${start.name} → ${end.name}: ${miles} mi, ${fmtMin(minutes)} in ${future ? `traffic predicted for ${args.departureTime}` : 'current traffic'}${g.toll ? `, tolls ≈ ${g.toll.currency} ${g.toll.amount.toFixed(2)}` : ''}${args.departureTime && !future ? ' (the departure given was in the past, so this is now)' : ''}.`,
        { miles, minutes, departureTime: future ? args.departureTime : null, toll: g.toll ?? null, start, end },
      );
    } catch (e) {
      return fail(`Traffic could not be measured: ${String(e.message).slice(0, 200)}`);
    }
  });

  server.registerTool('evaluate_trip_concept', {
    title: 'Evaluate multi-day concepts',
    description: 'Measure up to three multi-day route concepts on real roads before creating anything: miles, riding time at group pace, per-day arrival times, after-dark arrivals, longest fuel gap against the bike\'s range, climbing, and the delta against the quickest concept. Days split at locations of kind "lodging". Use this to compare shapes of a trip; then create_trip with the one the rider likes.',
    inputSchema: {
      concepts: z.array(z.object({
        id: z.string(),
        title: z.string(),
        locations: z.array(z.object({
          name: z.string(), lat: z.number(), lng: z.number(),
          kind: z.enum(['start', 'end', 'road', 'fuel', 'food', 'lodging', 'attraction']).optional(),
          placeId: z.string().optional(),
          dwell: z.number().optional(),
        })).min(2).max(20),
      })).min(1).max(3),
      routePrefs: z.object({ style: z.enum(['quick', 'touring', 'backroads']).optional(), avoidTolls: z.boolean().optional() }).optional(),
      range: z.object({ comfort: z.number().optional(), absolute: z.number().optional() }).optional().describe('fuel range in miles; default 180 / 200'),
      pace: z.number().optional(),
      depart: z.string().optional().describe('24h "08:00"'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const out = await evaluateImpl(args);
      const lines = out.options.map((o) => (o.error
        ? `• ${o.title}: could not be measured — ${o.error}`
        : `• ${o.title}: ${o.metrics.miles} mi, ${fmtMin(o.metrics.rideMinutes)} riding over ${o.metrics.dayCount} day${o.metrics.dayCount === 1 ? '' : 's'}; longest day ${o.metrics.longestDayMiles} mi; longest fuel gap ${o.metrics.longestFuelGap} mi${o.metrics.overComfort ? ' (OVER comfort range)' : ''}${o.metrics.afterDusk ? '; arrives after dusk' : ''}${o.metrics.ascentFeet != null ? `; ${o.metrics.ascentFeet} ft climbing` : ''}${o.id === out.baselineId ? ' — quickest' : ` (+${o.metrics.deltaMinutes} min, ${o.metrics.deltaMiles >= 0 ? '+' : ''}${o.metrics.deltaMiles} mi)`}`));
      return ok(lines.join('\n'), { ...out, options: out.options.map(({ searchPolyline, ...o }) => o) });
    } catch (e) {
      return fail(`Evaluation failed: ${String(e.message).slice(0, 200)}`);
    }
  });

  // ---- the library ----
  server.registerTool('create_trip', {
    title: 'Create a trip',
    description: 'Save a complete itinerary you authored into the rider\'s library: name, start date, and days in order, each with its stops in road order (first = start, last = end), optional lodging, meals and hard gates. Fuel stops, hotels and restaurants without a placeId are checked against Google Places after the fact: real ones are snapped to their listing, missing ones are flagged unverified — never silently kept. Returns the trip and an Open in Roadbook link.',
    inputSchema: {
      name: z.string(),
      startDate: z.string().describe('YYYY-MM-DD'),
      days: z.array(z.object({
        title: z.string(),
        phase: z.enum(['prep', 'outbound', 'rally', 'return']).optional().describe('outbound = the way out; return = the way home; rally = days spent AT a destination; prep = arrival/staging'),
        depart: z.string().optional().describe('"8:30 AM"'),
        summary: z.string().optional(),
        waypoints: z.array(z.object({
          name: z.string(), lat: z.number(), lng: z.number(),
          kind: z.enum(['start', 'via', 'fuel', 'photo', 'end']).optional(),
          fuel: z.boolean().optional(),
          placeId: z.string().optional(),
          placed: z.enum(['ai', 'rider']).optional().describe('a deliberate spot no listing names (a pass, a pullout)'),
          note: z.string().optional(),
          dwell: z.number().optional(),
        })).min(2),
        lodging: z.object({ status: z.enum(['booked', 'reserve', 'none']).optional(), name: z.string().optional(), where: z.string().optional(), note: z.string().optional(), placeId: z.string().optional() }).optional(),
        meals: z.array(z.object({ meal: z.enum(['breakfast', 'lunch', 'dinner']), name: z.string(), where: z.string().optional(), note: z.string().optional(), placeId: z.string().optional() })).optional(),
        gates: z.array(z.object({ label: z.string(), by: z.string(), waypointIndex: z.number().int().optional() })).optional(),
      })).min(1).max(30),
      summary: z.string().optional().describe('two or three sentences on the whole trip'),
      routePrefs: z.object({ style: z.enum(['quick', 'touring', 'backroads']).optional(), avoidTolls: z.boolean().optional() }).optional(),
      riders: z.number().int().min(1).optional(),
      range: z.object({ comfort: z.number().optional(), absolute: z.number().optional(), mpg: z.number().optional() }).optional(),
      pace: z.number().optional(),
      phaseLabels: z.object({ prep: z.string().optional(), outbound: z.string().optional(), rally: z.string().optional(), return: z.string().optional() }).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: uiMeta('ui://roadbook/trip'),
  }, async (args) => {
    const trip = tripFromDays(args);
    let note = '';
    if (googleKey) {
      try {
        const report = await verifyTripImpl(trip, { key: googleKey, deadline: now() + budgetMs() - 500, maxLookups: 60 });
        if (report?.unverified?.length) note = ` Place check: ${report.unverified.length} stop${report.unverified.length === 1 ? '' : 's'} could not be found and ${report.unverified.length === 1 ? 'is' : 'are'} flagged unverified (${report.unverified.map((u) => u.name ?? u).slice(0, 5).join(', ')}).`;
        else if (report?.snapped) note = ` Place check: ${report.snapped} stop${report.snapped === 1 ? '' : 's'} snapped to ${report.snapped === 1 ? 'its' : 'their'} listing.`;
      } catch { /* a plan that could not be checked is still a plan */ }
      const left = unverifiedLeft(trip);
      if (left) note += ` ${left} stop${left === 1 ? '' : 's'} not yet checked (a long trip is verified in passes) — call verify_trip to continue.`;
    }
    const tripId = newTripId();
    const row = await saveTrip(db, userId, { tripId, name: trip.meta.title, trip });
    const summary = tripSummary(row);
    return ok(
      `Created "${trip.meta.title}": ${trip.days.length} day${trip.days.length === 1 ? '' : 's'} from ${trip.meta.startDate}. tripId ${tripId}. Open it: ${tripUrl(tripId)}${note}`,
      { trip: summary, stops: tripStops(trip) },
    );
  });

  server.registerTool('list_trips', {
    title: 'List trips',
    description: 'The rider\'s Roadbook library: every trip with its dates, days and route character.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const rows = await listTrips(db, userId);
    const items = rows.map((r) => tripSummary(r)).map(({ dayList, ...s }) => s);
    if (!items.length) return ok('The library is empty.', { trips: [] });
    return ok(items.map((s) => `• ${s.title} — ${s.startDate ?? 'undated'}${s.endDate && s.endDate !== s.startDate ? ` → ${s.endDate}` : ''}, ${s.days} day${s.days === 1 ? '' : 's'}${s.quick ? ' (quick ride)' : ''} [tripId ${s.tripId}]`).join('\n'), { trips: items });
  });

  server.registerTool('get_trip', {
    title: 'Get a trip',
    description: 'One trip in full: days, every stop with its id (for update_trip), lodging, meals, gates. With measure=true each day is routed on real roads (miles and riding minutes) as time allows.',
    inputSchema: {
      tripId: z.string(),
      measure: z.boolean().optional().describe('route the days on real roads. Resumable: routed days are cached, so call again until the answer says complete'),
      fromDayId: z.string().optional().describe('with measure: start routing at this day (earlier unrouted days are left for later)'),
    },
    annotations: { readOnlyHint: true },
    _meta: uiMeta('ui://roadbook/trip'),
  }, async (args) => {
    const row = await getTripRow(db, userId, args.tripId);
    if (!row) return fail(`No trip ${args.tripId} in this library.`);
    let measured = null; let geometry = null; let m = null;
    if (args.measure) {
      m = await measureDaysImpl(row.trip, { deadline: now() + budgetMs(), tripId: args.tripId, fromDayId: args.fromDayId ?? null });
      measured = m.measured; geometry = Object.fromEntries(Object.entries(m.geometry).map(([k, g]) => [k, thin(g)]));
    }
    const summary = tripSummary(row, { measured });
    const lines = summary.dayList.map((d) => `• ${d.dow ?? ''} ${d.date ?? ''} ${d.title}: ${d.from} → ${d.to}, ${d.stops} stops${d.roadMiles != null ? `, ${d.roadMiles} mi / ${fmtMin(d.ridingMinutes)}` : ` (~${d.straightLineMiles} mi straight-line)`}${d.lodging ? ` · ${d.lodging}` : ''}${d.unverified.length ? ` · UNVERIFIED: ${d.unverified.join(', ')}` : ''} [dayId ${d.id}]`);
    const left = unverifiedLeft(row.trip);
    return ok(
      `${summary.title} (${summary.startDate} → ${summary.endDate}, ${summary.riders} rider${summary.riders === 1 ? '' : 's'}, ${summary.routePrefs.style} roads)\n${lines.join('\n')}${m ? `\n${measureNote(m)}` : ''}${left ? `\n${left} stop${left === 1 ? '' : 's'} not yet checked against Places — verify_trip continues that.` : ''}\nOpen: ${summary.url}`,
      { trip: summary, stops: tripStops(row.trip), ...(geometry ? { geometry } : {}), ...(m ? { measure: { routed: m.routed, cached: m.cached, nextDayId: m.nextDayId, complete: m.complete } } : {}), uncheckedStops: left },
    );
  });

  server.registerTool('update_trip', {
    title: 'Update a trip',
    description: 'Edit a trip with the same operations Roadbook\'s own Copilot uses: add/remove/update/reorder/move waypoints, set day fields (title, summary, depart, phase), add days, gates, meals, lodging, reservations, or trip settings (set_meta: routePrefs, startDate, riders, range, pace). Reference real day and waypoint ids from get_trip. New places without a placeId are verified against Google Places first.',
    inputSchema: {
      tripId: z.string(),
      ops: z.array(z.record(z.any())).min(1).describe(`Each op is {op, ...}. op ∈ ${CHAT_TOOL.input_schema.properties.ops.items.properties.op.enum.join(' | ')}. Fields per op: dayId, waypointId, index, waypoint {name, lat, lng, kind, fuel, placeId, note}, patch, field + value (set_day_field), day (add_day: {title, phase, depart, summary}), gate {label, by, waypointId}, meal + patch (update_meal), reservation, moduleId. Dates cascade from meta.startDate automatically.`),
      summary: z.string().optional().describe('one sentence on what this change does'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async (args) => {
    const row = await getTripRow(db, userId, args.tripId);
    if (!row) return fail(`No trip ${args.tripId} in this library.`);
    let checkNote = '';
    if (googleKey) {
      try {
        const v = await verifyProposalImpl({ ops: args.ops }, { trip: row.trip, key: googleKey, deadline: now() + Math.min(5000, budgetMs() - 1500), maxLookups: 12 });
        checkNote = describeVerification(v);
      } catch { /* unverifiable is not unappliable */ }
    }
    const { trip, errors, described } = applyTripOps(row.trip, args.ops);
    if (errors.length === args.ops.length) return fail(`No op could be applied: ${errors.join('; ')}`);
    await saveTrip(db, userId, { tripId: args.tripId, name: row.name === row.trip.meta?.title ? trip.meta.title : row.name, trip, scenarios: row.scenarios, chat: row.chat, remote: row.remote });
    const summary = tripSummary({ ...row, trip });
    return ok(
      `Applied ${args.ops.length - errors.length} of ${args.ops.length} change${args.ops.length === 1 ? '' : 's'} to "${trip.meta.title}":\n${described.map((d) => `• ${d}`).join('\n')}${errors.length ? `\nSkipped: ${errors.join('; ')}` : ''}${checkNote ? `\n${checkNote}` : ''}`,
      { trip: summary, stops: tripStops(trip), applied: described, errors, verification: checkNote || null },
    );
  });

  server.registerTool('verify_trip', {
    title: 'Verify a trip\'s places',
    description: 'Check the trip\'s fuel stops, lodging, restaurants and named stops against Google Places, RESUMABLY: each call checks what has not been checked yet until its time runs out, snaps real places to their listing and flags missing ones unverified; call again until remaining is 0. Use after create_trip on a long trip. retryUnverified re-checks stops already flagged (after you have renamed or moved them).',
    inputSchema: { tripId: z.string(), retryUnverified: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => {
    if (!googleKey) return fail('Place verification is not configured on this server (GOOGLE_MAPS_API_KEY).');
    const row = await getTripRow(db, userId, args.tripId);
    if (!row) return fail(`No trip ${args.tripId} in this library.`);
    const trip = structuredClone(row.trip);
    const before = unverifiedLeft(trip);
    let report = null;
    try {
      report = await verifyTripImpl(trip, { key: googleKey, deadline: now() + budgetMs() - 500, maxLookups: 60, retryUnverified: args.retryUnverified === true });
    } catch (e) {
      return fail(`Verification failed: ${String(e.message).slice(0, 200)}`);
    }
    await saveTrip(db, userId, { tripId: args.tripId, name: row.name, trip, scenarios: row.scenarios, chat: row.chat, remote: row.remote });
    const remaining = unverifiedLeft(trip);
    const flagged = (trip.days ?? []).flatMap((d) => [...(d.waypoints ?? []), d.lodging, ...(d.meals ?? [])].filter((x) => x && x.verified === false).map((x) => x.name));
    return ok(
      `Checked ${report?.checked ?? 0} stop${report?.checked === 1 ? '' : 's'} this call (${report?.snapped ?? 0} snapped to a listing, ${report?.unverified?.length ?? 0} not found). ${remaining ? `${remaining} still unchecked — call verify_trip again.` : 'Every stop has been checked.'}${flagged.length ? ` Flagged unverified on the trip: ${flagged.slice(0, 8).join(', ')}${flagged.length > 8 ? '…' : ''} — re-pick or rename them, then verify_trip with retryUnverified.` : ''}`,
      { tripId: args.tripId, checked: report?.checked ?? 0, snapped: report?.snapped ?? 0, notFound: report?.unverified ?? [], before, remaining, complete: remaining === 0, flagged },
    );
  });

  server.registerTool('delete_trip', {
    title: 'Delete a trip',
    description: 'Remove a trip from the rider\'s library (a tombstone, the same soft delete the app performs). Confirm with the rider first.',
    inputSchema: { tripId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (args) => {
    const gone = await tombstoneTrip(db, userId, args.tripId);
    return gone ? ok(`Deleted trip ${args.tripId}.`, { tripId: args.tripId, deleted: true }) : fail(`No trip ${args.tripId} in this library.`);
  });

  server.registerTool('export_gpx', {
    title: 'Export GPX',
    description: 'The trip (or one day) as a GPX file: waypoints carry the planned ETA in their names, tracks follow the real roads for every day already routed (get_trip measure, cached) plus what this call can route in time; straight lines between stops for the rest, and the answer says how many. For a fully routed long trip, run get_trip measure until complete first.',
    inputSchema: { tripId: z.string(), dayId: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const row = await getTripRow(db, userId, args.tripId);
    if (!row) return fail(`No trip ${args.tripId} in this library.`);
    const trip = args.dayId ? { ...row.trip, days: row.trip.days.filter((d) => d.id === args.dayId) } : row.trip;
    if (!trip.days.length) return fail(`No day ${args.dayId} on that trip.`);
    const r = await measureDaysImpl(trip, { deadline: now() + budgetMs() - 500, tripId: args.tripId });
    const routes = Object.fromEntries(Object.entries(r.geometry).map(([k, g]) => [k, { geometry: g }]));
    const gpx = tripToGpx(trip, routes, null, args.dayId ?? null);
    const routedDays = Object.keys(routes).length;
    return {
      content: [
        text(`GPX for "${trip.meta.title}" — ${trip.days.length} day${trip.days.length === 1 ? '' : 's'}, ${routedDays} routed on real roads${routedDays < trip.days.length ? `, ${trip.days.length - routedDays} as straight lines. Run get_trip with measure until it reports complete, then export again for a fully routed file.` : '.'}`),
        { type: 'resource', resource: { uri: `roadbook://trips/${args.tripId}/gpx${args.dayId ? `?day=${args.dayId}` : ''}`, mimeType: 'application/gpx+xml', text: gpx } },
      ],
      structuredContent: { tripId: args.tripId, days: trip.days.length, routedDays, complete: r.complete, nextDayId: r.nextDayId, bytes: gpx.length },
    };
  });

  server.registerTool('rider_profile', {
    title: 'Rider profile',
    description: 'What the rider told Roadbook about themselves: saved places (home, work, favorites), the bike, usual road style and toll rule, fuel range, group pace, and stated tastes. Read it before planning so the plan fits.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const { data, error } = await db.from('user_profile').select('profile, updated_at').eq('user_id', userId).maybeSingle();
    if (error) return fail(`Profile read failed: ${error.message}`);
    const p = data?.profile ?? {};
    const places = (p.places ?? []).map((x) => ({ role: x.role, name: x.name, lat: x.lat, lng: x.lng, ...(x.placeId ? { placeId: x.placeId } : {}) }));
    const facts = {
      name: session.name ?? null,
      places,
      bike: p.bike ?? null,
      routePrefs: p.routePrefs ?? p.routeStyle ?? null,
      range: p.range ?? DEFAULT_RANGE,
      pace: p.pace ?? null,
      taste: p.taste ?? p.tastes ?? null,
      updatedAt: data?.updated_at ?? null,
    };
    const home = places.find((x) => x.role === 'home');
    return ok(
      data ? `${facts.name ? `${facts.name}. ` : ''}${home ? `Home: ${home.name}. ` : ''}${facts.bike ? `Bike: ${typeof facts.bike === 'string' ? facts.bike : JSON.stringify(facts.bike)}. ` : ''}${facts.routePrefs ? `Roads: ${JSON.stringify(facts.routePrefs)}. ` : ''}Range: ${JSON.stringify(facts.range)}.${facts.taste ? ` Tastes: ${typeof facts.taste === 'string' ? facts.taste : JSON.stringify(facts.taste)}.` : ''}` : 'No profile saved yet — plan from what the rider tells you.',
      facts,
    );
  });

  // ---- resources ----
  for (const [uri, r] of Object.entries(UI)) {
    server.registerResource(r.name, uri, { description: r.description, mimeType: 'text/html;profile=mcp-app', _meta: UI_META }, async () => ({
      contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: r.html, _meta: UI_META }],
    }));
  }
  server.registerResource('Trip library', 'roadbook://trips', { description: 'The rider\'s trips as JSON summaries.', mimeType: 'application/json' }, async () => {
    const rows = await listTrips(db, userId);
    return { contents: [{ uri: 'roadbook://trips', mimeType: 'application/json', text: JSON.stringify(rows.map((r) => { const { dayList, ...s } = tripSummary(r); return s; }), null, 2) }] };
  });
  server.registerResource('Trip', new ResourceTemplate('roadbook://trips/{tripId}', {
    list: async () => {
      // a library that cannot be read right now is an empty list, not a
      // failed resources/list — the UI resources must still be discoverable
      try {
        const rows = await listTrips(db, userId);
        return { resources: rows.map((r) => ({ uri: `roadbook://trips/${r.trip_id}`, name: r.name, mimeType: 'application/json' })) };
      } catch { return { resources: [] }; }
    },
  }), { description: 'One trip document, as the app stores it.', mimeType: 'application/json' }, async (uri, { tripId }) => {
    const row = await getTripRow(db, userId, String(tripId));
    if (!row) throw new Error(`No trip ${tripId}`);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ tripId: row.trip_id, name: row.name, updatedAt: row.updated_at, trip: row.trip }, null, 2) }] };
  });

  // ---- prompts ----
  server.registerPrompt('plan_a_ride', {
    title: 'Plan a ride',
    description: 'Walk a rider from an idea to a saved trip: places, measured roads with traffic, their pick, saved.',
    argsSchema: {
      from: z.string().describe('where the ride starts'),
      to: z.string().describe('where it ends'),
      when: z.string().optional().describe('date and rough departure, e.g. "Saturday around 9"'),
      style: z.string().optional().describe('quick, touring or back roads'),
    },
  }, ({ from, to, when, style }) => ({
    messages: [{
      role: 'user',
      content: text(`Plan a motorcycle ride from ${from} to ${to}${when ? ` on ${when}` : ''}${style ? `, ${style} roads` : ''}.
Steps: (1) read rider_profile for range and road style; (2) use search_places if either end is ambiguous; (3) call route_options with the departure so the rider sees every road with traffic and tolls; (4) explain the trade-offs in two or three sentences, then wait for their pick; (5) save_route_option with their choice; (6) offer to add fuel or lunch along the chosen road with search_places(alongOptionSetId) and update_trip.`),
    }],
  }));

  return server;
}

/**
 * Answer one Streamable-HTTP request for an authenticated rider. Stateless:
 * no session id, JSON responses, a fresh server per call.
 */
export async function handleMcpRequest(req, session, { deps, authInfo } = {}) {
  const server = buildServer(session, deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req, {
      authInfo: authInfo ?? { token: 'session', clientId: 'roadbook', scopes: [], extra: { session } },
    });
  } finally {
    // the transport closes with the response; the server is garbage after
    transport.close().catch(() => {});
  }
}

export { APP_URL };

# The Roadbook MCP server

Riders already ask the AI they carry where to go. The MCP server lets that
conversation end as a trip in **their** Roadbook library instead of a
paragraph: the model measures the roads with the app's own router, shows the
choice as an interactive picker, and saves the one the rider taps.

```
https://roadbook-app.netlify.app/mcp
```

Transport: Streamable HTTP, stateless (JSON responses, no sessions).
Protocol: MCP 2025-06-18, with the MCP Apps extension (2026-01-26) for the
two interactive surfaces.

## Connect

### Hosts that speak OAuth (Claude.ai, Claude Desktop connectors, ChatGPT, Claude Code, Cursor)

Add the URL above as a custom connector / remote MCP server. The host reads
`/.well-known/oauth-protected-resource`, discovers Supabase Auth as the
authorization server, registers itself, and sends the rider to Roadbook's
consent page (`/oauth/consent`). The rider signs in with their Roadbook
account, approves, and the host holds a token issued for that account. The
same Row Level Security the app runs under applies to every request.

```bash
# Claude Code
claude mcp add --transport http roadbook https://roadbook-app.netlify.app/mcp
```

### Hosts that only take a header (a stdio bridge, a script)

Roadbook → Settings → **Connect your AI** → *Make a token*. The token
(`rbk_…`) is shown once; only its SHA-256 is stored, and it can be revoked
there any time.

```bash
ROADBOOK_TOKEN=rbk_… node mcp/bridge.mjs        # stdio ⇄ /mcp
```

```json
{ "mcpServers": { "roadbook": {
  "command": "node", "args": ["/path/to/roadbook/mcp/bridge.mjs"],
  "env": { "ROADBOOK_TOKEN": "rbk_…" } } } }
```

Or straight over HTTP with `Authorization: Bearer rbk_…`.

Anonymous crew sessions (the join-code door) are refused: that credential
opens one shared trip, never a private library.

## Tools

| Tool | What it does |
| --- | --- |
| `rider_profile` | Saved places (home / work / favorites), bike, road style, toll rule, fuel range, pace, tastes. Read it first. |
| `search_places` | Google Places, strict by category (fuel, food, coffee, lodging, sights, moto, help) or by name; near a point or **along a measured route option** with the detour each hit costs. Rows carry `placeId`. |
| `route_options` | Every road worth riding between start and end (optionally through stops): Quick / Touring / Back roads by Valhalla motorcycle costing plus the router's alternates, merged (`src/engine/routeOptions.js`, the same engine as the app's route sheet). Per option: miles, road minutes, **predicted traffic minutes for the departure**, toll flag and **estimated toll price** (Google), via-road label, fastest/shortest flags. Returns an `optionSetId`. Renders the picker app. |
| `save_route_option` | One option → a one-day trip in the library, stamped with the option's route character (an alternate road is pinned with pass-through vias the way the app's drag gesture does). Returns the trip and an `#trip=<id>` link. Renders the trip app. |
| `traffic_eta` | Google's clock for a corridor at a departure (predicted when future), with a toll estimate. |
| `evaluate_trip_concept` | Up to three multi-day concepts measured on real roads: miles, riding time at pace, per-day arrivals, after-dark, longest fuel gap vs range, climbing, delta vs the quickest (`netlify/lib/route-opportunities.mjs`). |
| `create_trip` | A whole authored itinerary → a trip document (days, stops in road order, lodging, meals, gates). Fuel / hotels / restaurants without a `placeId` are verified against Places after the fact and snapped or flagged **unverified**, exactly as the in-app planner's are. |
| `list_trips` / `get_trip` | The library; one trip with every id. `measure: true` routes the days on real roads, **resumably**: routed days are cached per trip (7 days), each call routes what is missing until its budget ends and reports `nextDayId` / `complete`; call again to continue. `fromDayId` starts a pass later in the trip. |
| `verify_trip` | Places verification, **resumably**: each call checks stops not yet checked until its budget ends and reports `remaining`; call until 0. `retryUnverified` re-checks flagged stops after they were renamed or moved. |
| `update_trip` | The app's own op vocabulary (`add_waypoint`, `set_day_field`, `set_meta`, `add_gate`, …) applied through `applyOps`; new places verified first; `describeOps` reported back. |
| `delete_trip` | The app's soft delete (a tombstone). |
| `export_gpx` | GPX with ETAs in the waypoint names, tracks on real roads where routed in time. |

Resources: `ui://roadbook/route-options`, `ui://roadbook/trip` (MCP Apps,
`text/html;profile=mcp-app`), `roadbook://trips`, `roadbook://trips/{tripId}`.
Prompt: `plan_a_ride`.

## The rich UI (MCP Apps)

`route_options`, `save_route_option`, `create_trip` and `get_trip` declare a
`ui://` resource in `_meta`. A host that supports MCP Apps renders it inline:

- **Route options** — the roads drawn over a basemap (Esri street tiles,
  declared in the resource CSP; the SVG stands alone if a host blocks
  images), a card per option with road time, traffic time and its delta,
  tolls, fastest / shortest tags; tap a road or a card to select; *Save as a
  trip* calls `save_route_option` back through the host and then offers
  *Open in Roadbook*. Selections and the save are reported to the model
  through `ui/update-model-context`.
- **Trip** — the day list, stops, lodging, verified/unverified counts, the
  route silhouette, *Open in Roadbook*.

Hosts without MCP Apps get the same facts as text and `structuredContent`.

## How it is built

- `netlify/functions/mcp.mjs` — the door: CORS, bearer check, 401 with
  `WWW-Authenticate: Bearer resource_metadata="…"`, one `McpServer` per
  request over `WebStandardStreamableHTTPServerTransport` (stateless).
- `netlify/functions/mcp-oauth-metadata.mjs` — RFC 9728 document.
- `netlify/lib/mcp-auth.mjs` — Supabase JWT via `auth.getUser` (RLS-bound
  client when no service key) or `rbk_` token by hash (needs
  `SUPABASE_SERVICE_ROLE_KEY`).
- `netlify/lib/mcp-server.mjs` — tools, resources, prompt.
- `netlify/lib/mcp-routes.mjs` — options + traffic + tolls; `mcp-library.mjs`
  — `user_trips` rows and trip-document builders on the app's engine
  (`ops.js`, `dates.js`, `tripEngine.js`); `mcp-store.mjs` — option sets
  (Netlify Blobs, 24 h); `mcp-ui.mjs` — the two HTML apps;
  `google-routes.mjs` — the Routes request the app's traffic quote and the
  server share.
- `src/components/ConnectorPanel.jsx` (Settings → Connect your AI),
  `src/components/OAuthConsent.jsx` (`/oauth/consent`),
  `supabase/migrations/…_mcp_tokens.sql`.
- The app pulls the library again on `#trip=<id>` and when it returns to the
  foreground after a minute away, so a trip saved by a connector shows up
  without a sign-out (`useLibraryBackup().refresh`).

Environment (Netlify site): `SUPABASE_URL` + `SUPABASE_KEY` (or the `VITE_`
pair already set), `SUPABASE_SERVICE_ROLE_KEY` (connector tokens only),
`GOOGLE_MAPS_API_KEY` (places, traffic, tolls — already set),
`VALHALLA_URL` / `VITE_VALHALLA_URL` (own router), `ROADBOOK_APP_URL`.

Supabase (dashboard, once): Authentication → OAuth Server → enable, path
`/oauth/consent`, allow dynamic client registration. `supabase/config.toml`
carries the same under `[remotes.production.auth.oauth_server]`.

## Verify

```bash
npm run mcp:check        # protocol, options, save, library, resumable measure/verify, auth, functions
```

## Budgets and long trips

Netlify's synchronous function limit is 10 s, so every tool measures in
order and stops at a deadline. `MCP_TOOL_BUDGET_MS` (default 6500) is the
per-call budget for routing and verification; raise it on a host with longer
functions (Vercel) and every tool does more per call without a code change.

The expensive part of a long trip, authoring it, runs in the rider's own AI
over MCP, not in a function. On Roadbook's side a 30-day trip is:

1. `create_trip` with all 30 days in one call (assembling the document is
   milliseconds; the first verification pass runs inside the budget).
2. `verify_trip` until `remaining` is 0 (about 3–4 days of stops per call on
   Netlify: fuel, bed and meals are ~5 Places lookups a day).
3. `get_trip` with `measure: true` until `complete` (about 4–5 days per call
   against the public Valhalla, ~1 s a day; routed days are cached).
4. `export_gpx` once everything is cached, for a fully routed file.

Chunk size falls out of those numbers: on Netlify, 4 days per pass; on a
60 s function, the whole trip in one.

# Handoff: Mapbox as the map (satellite-streets, tappable POIs, mapbox-gl)

**Branch:** `claude/mapbox-satellite-integration-e61349` (PR against `main`).
**State (Sep 13, 2026, local session):** the swap to Mapbox is built, verified against the real Mapbox API, and its sims are green. This doc records what the cloud session built, what the local session changed, and what is deliberately left.

## What changed, in order

### 1. The cloud session (commits `15cf912`, `8614b5b`)
A composite satellite (imagery under OpenFreeMap's vector roads / labels / POIs) with MapLibre, a POI tap → `PoiCard.jsx`, and Mapbox's satellite-streets style rewritten through `transformRequest` when a token existed. Verified only against a mocked Mapbox — the sandbox had no route to `api.mapbox.com`.

### 2. The local session — terms, then the renderer
- **Mapbox Product Terms (PDF dated July 21, 2026) read in full.** Using Mapbox tiles through MapLibre is not forbidden, but §2.8.3 + §3.58 bill a map drawn by anything other than Mapbox GL JS ("Qualified Renderer") per API request instead of per Map Load. §2.8.1 caps on-device caching at 30 days. §1.13 forbids integrating Mapbox content in a way that would subject it to share-alike licences.
- **Owner's call:** "since mapbox wants you to use their SDK we will move away from openfree maps." Renderer swapped `maplibre-gl` → `mapbox-gl@3.30`; CSS classes `.maplibregl-*` → `.mapboxgl-*`; OpenFreeMap styles, the liberty compositor, the Google Map Tiles sessions and `mapboxTransformRequest` deleted. Every basemap is now a Mapbox style (`MAPBOX_STYLES` in `basemaps.js`); Esri hybrid raster is the only no-token / style-failed fallback.
- **Attribution:** Mapbox's terms want the wordmark and "© Mapbox © OpenStreetMap" on the map, so `attributionControl: { compact: true }` is back on both maps; the nav map puts the logo top-left because the ride bar owns the bottom.
- **mapbox-gl gotcha found live:** mutating symbol layers while placement is running against a fresh style (load, right after `setStyle`) throws an uncaught `TypeError … continuePlacement`. The `styledata` redraw and every `hideNativeRoadShields` call are deferred to `once('idle')`; a probe confirmed visibility flips and add/remove are clean after idle.
- **Exit shields are kept** — only `road-number-shield` is hidden under ours.
- **PoiCard** looks the place up strict-typed first, then by name with no type (the WYO Theater in Sheridan matched nothing under `tourist_attraction`).
- **Dev plumbing:** `vite.config.js` loads `.env.local` into `process.env` for the functions (so `GOOGLE_MAPS_API_KEY` reaches `nearby-places` locally); `.claude/launch.json` pins the dev server to 5199.

## Verification
| what | how | result |
|---|---|---|
| Real Mapbox API | dev server with `VITE_MAPBOX_TOKEN` in `.env.local`, in-app browser | satellite-streets loads with `poi-label`; shields hidden, exits kept; our routes on top; POI tap → Cowboy Cafe ★4.5 (1308) and WYO Theater ★4.7 (209) from Google; Streets/Dark/Light switches with zero page errors; 3D on Mapbox's DEM; Ride Mode chase camera over Mapbox with our I-90 shields; logo + ⓘ credit present |
| `tools/sims/mapbox-check.mjs` | mocked `api.mapbox.com` (`fixtures/mapbox-mock.mjs`) | SDK fetched the style with a public token and opened a v3 map session; TileJSON for both sources; no raw `mapbox://`; no OpenFreeMap / Google tile / Esri request with a token; four pills; wordmark above the ride bar; zero page errors; a 401 lands on Esri with the trip still drawn |
| `tools/sims/poi-tap-check.mjs` | mocked | pure helpers over a satellite-streets-shaped fixture, card, verified fuel add by route order, unverified cafe, disabled without a day, nav map |
| regressions | place-pins, nearby, route-drag, quick-ride, overview-lock, traffic-anchor, valhalla | see the PR description for the numbers |

Run any sim: `npm run dev` (port 5199) in one shell, `node tools/sims/<name>.mjs` in another. `playwright-core` is not a dependency — `npm i --no-save playwright-core` once per checkout.

## Token
Public `pk.` token, default public scopes, nothing secret. URL restrictions (Mapbox accepts no wildcards): `https://roadbook-app.netlify.app` and `http://localhost:5199`. Deploy previews are on their own subdomains and fall back to Esri. `VITE_MAPBOX_TOKEN` is set in the Netlify site env (all contexts) and in `.env.local`.

## Deliberately not done
- No Ride Mode POI tap (the plan map has it) — glove UX is an open question.
- No Mapbox search / geocoding — Google Places stays the fact source for every tapped POI.
- `warmTilesAhead` is a no-op on Mapbox (its tile URLs come from TileJSON; mapbox-gl's tile cache holds the corridor).
- No iOS simulator pass in this session — worth doing on the deploy preview: POI tap vs pan on a real touch stack, the PoiCard above the mode bar, Mapbox glyph loading, and the chase camera over Mapbox's darker imagery.

## Next (owner, same day)
"I'm not a fan of our location modal… why would we link out to Google Maps? We should have our own detail page built like Google's." → a Roadbook place sheet: photo, rating/count, price, today's hours + weekly table, address, tap-to-call, website, plus the route facts Google cannot show (ETA at the stop, detour cost, gate margins, fuel verdict, open-at-arrival), and Add / Swap / Ride here. The Maps link goes away.

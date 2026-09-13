# Handoff: composite satellite, tappable POIs, Mapbox

**Branch:** `claude/trip-overview-templates-qe8wlc` (PR against `main`).
**State when this was written (Sep 13, 2026):** everything below is built, built cleanly, and passes its sims. What is NOT done is any run against the real Mapbox API and any run on an iOS simulator — the cloud sandbox has no route to `api.mapbox.com` and no Xcode. Those two are the local session's job.

## What was built, in order

### 1. Satellite is a composite (merged: #84, #85; this branch: `15cf912`)
Google's hybrid tiles are one flat picture — roads, labels and POI icons baked into pixels with nothing to tap. Tesla composites: imagery as the bottom layer, vector roads / labels / POIs drawn on top, so a POI is a symbol feature with a name and a class. MapLibre (Mapbox GL's fork) does the same.

- `src/engine/basemaps.js`
  - `compositeSatellite(liberty, imagery)` — pure. Keeps only liberty's road / road-name / place / POI / park-name layers, recolours type white with a dark halo, caps road opacity at 0.8, puts imagery first, tags `metadata.roadbook = { composite, imagery, poiLayers }`.
  - `fetchLibertyStyle()` — OpenFreeMap's style JSON, cached 7 days in `moto.libertyStyle.v1`.
  - Imagery: a bare Google `satellite` session (`G_SESSION_SPECS.satellite`) with a key, Esri World_Imagery without.
  - `cachedCompositeStyle()` (sync) / `compositeStyle()` (async) / `poiLayerIds(map)`.
- `src/components/MapView.jsx` — `satelliteStyle()` prefers the composite → Google flat hybrid → Esri. Basemap key is `sat` (the old `gsat` is gone). The switch effect re-applies when the Satellite style OBJECT is upgraded in place; the constructor's style is recorded in `appliedStyleRef` so the first load never swaps a style for itself.
- `src/components/RideMode.jsx` — `navStyleFor('hybrid')` is the same chain; a ride that opened on the flat fallback swaps to the composite when its pieces arrive.

### 2. POI tap → PoiCard (same commit)
- MapView's click handler hit-tests `poiLayerIds` with `queryRenderedFeatures` BEFORE click-to-add and before the no-day early return. Cursor is a pointer over those layers.
- `src/components/PoiCard.jsx` — OSM/Mapbox name + class glyph; resolves against Google Places strict-typed to the category within 2 mi; accepts a match within 0.35 mi sharing a word of the name; rating / price / open now / ✓ Google. **Add** lands by route order (`routeAwareIndex`) with `placeId` + `verified: 'google'`; a fuel POI becomes a fuel stop; no listing → added unverified; no day selected → Add disabled, "Pick a day to add it".
- `src/engine/nearby.js` — `poiCategory(cls, subclass)` / `poiGlyph()` bridge OpenMapTiles classes AND Mapbox Streets v8 `class` buckets + `maki` names to the picker's categories.
- Dev seam: `window.__poiTap(feature)` calls the exact handler the click uses (vector tiles cannot be mocked in a sim).

### 3. Mapbox as the satellite (uncommitted at the moment of the hold — see "Where this stopped")
- `MAPBOX_TOKEN` = `VITE_MAPBOX_TOKEN` at build time, or in dev `localStorage['moto.mapboxToken']` (lets a phone or a sim try it without a rebuild).
- `MAPBOX_STYLE = 'mapbox/satellite-streets-v12'` — Mapbox's own imagery + vector overlay; `fetchMapboxStyle()` cached 7 days in `moto.mapboxStyle.v1`; `mapboxComposite(style)` tags it with its `poi_label` layers.
- `mapboxTransformRequest(url, type, token)` — MapLibre does not understand `mapbox://`: rewrites styles / sprites / fonts / source URLs to `api.mapbox.com` and appends the token to any Mapbox URL lacking one. Passed as `transformRequest` to BOTH map constructors. A no-op without a token.
- With a token, `cachedCompositeStyle()` / `compositeStyle()` prefer Mapbox and fall back to the OpenFreeMap composite on any failure.
- `hideNativeRoadShields` hides Mapbox's `road-number-shield` under ours (id contains "shield").
- Tile warming (`navWarmLayers`) returns `[]` on Mapbox — its tile URLs come from TileJSON.

## Verification (all mocked-network sims on the dev server at :5199)
| sim | result |
|---|---|
| `tools/sims/poi-tap-check.mjs` | 42/42 — compositor as a pure function, both maps composite, card, verified fuel add at index 1, unverified cafe, disabled without a day |
| `tools/sims/mapbox-check.mjs` | 22/22 — every `mapbox://` rewrite, token appended, no raw mapbox:// request, `poi_label` tagged, shields hidden, Mapbox POI feature → glyph, nav map too |
| `place-pins-check` / `nearby-check` / `route-drag-check` / `quick-ride-check` / `overview-lock-check` / `traffic-anchor-check` | 49/49 · 44/44 · 25/25 · 14/14 · 24/24 · 9/9 |
| `valhalla-check` | 24/25 — the one pre-existing failure, identical on `main` |

Run any of them: `npm run dev` in one shell, `node tools/sims/<name>.mjs` in another (`PLAYWRIGHT_CHROMIUM` can point at a Chrome binary; the Mac default is Google Chrome).

## Where this stopped
The owner said "hold work" while `mapbox-check` had just gone 22/22 and `poi-tap-check` 42/42 after the Mapbox changes. The Mapbox commit is being made as this doc is written; if `git log` shows it, the branch is exactly the verified state.

## What the local session should do, in order

1. **Token.** Put the public token in `.env` as `VITE_MAPBOX_TOKEN=pk.…` (never commit `.env`). In Netlify, add `VITE_MAPBOX_TOKEN` to the site env (build-time; it is a public token, URL-restricted). In Mapbox → Tokens, restrict the token's URLs to `https://roadbook-app.netlify.app/*`, `https://deploy-preview-*--roadbook-app.netlify.app/*`, and `http://localhost:5199/*` once things work.
2. **Real Mapbox run.** `npm run dev`, open a trip, Satellite. Expect Mapbox imagery with Mapbox's roads, labels and POI icons; hover a POI on desktop → pointer; tap → PoiCard with a Google match. Check the console for any 401/403 from `api.mapbox.com` (a token or scope problem) and any MapLibre "unsupported expression" warnings — `satellite-streets-v12` is classic style spec and should load, but that is the one thing this sandbox could not confirm. If a Mapbox expression trips MapLibre, drop that layer in `mapboxComposite` rather than the style.
3. **Mapbox terms.** Mapbox's terms are read (moderate confidence, unverified here) as requiring Mapbox tiles/styles to be consumed through Mapbox SDKs. Read the current Product Terms. If that holds, the clean option is swapping the renderer to `mapbox-gl` (MapLibre's sibling; the API surface used here — markers, line-gradient with `lineMetrics`, `queryRenderedFeatures`, `setStyle`, terrain — exists in both). Estimate: 1–2 days plus a sim pass. Do not start that without the owner's call.
4. **iOS simulator.** Build (`npm run build`), serve `dist/` or use the Netlify deploy preview, add to Home Screen in Simulator's Safari. Things to look at that no sim can: the half sheet + map above it on a real touch stack, POI tap vs pan discrimination, the PoiCard above the mode bar, label glyph loading from Mapbox fonts, and that Ride Mode's chase camera still reads over Mapbox's darker imagery.
5. **Merge.** When 2 and 4 look right, mark the PR ready and squash-merge (repo convention). If Mapbox terms block, merging is still right — the Mapbox path is inert without a token and the OpenFreeMap composite stands on its own.

## Things deliberately NOT done
- No fifth basemap entry for "Mapbox" — Satellite IS Mapbox when the token exists. One word on the pill.
- No Mapbox search / geocoding — Google Places stays the fact source for every tapped POI.
- No Ride Mode POI tap yet (the plan map has it). Glove UX for that is an open question.
- The Esri no-key fallback keeps its baked (flat) icons; it shares a layer with road names.

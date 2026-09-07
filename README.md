# Roadbook

AI motorcycle trip planning platform — born as the **Sturgis 2026 · La Expedición Chilena** field guide, grown into a zero-to-100 planner for any multi-day ride.

**Live:** https://roadbook-app.netlify.app

## What it does

- **Trip library** — multiple trips; create from scratch, through an AI planning conversation, or from the bundled Sturgis 2026 template.
- **Routed map** — MapLibre GL (dark / light / satellite) with Valhalla motorcycle routes. A trip-wide Quick / Touring / Back roads control and toll preference drive both Plan and Ride Mode; Google Routes and OSRM remain safety fallbacks. Hover any stop or leg for details; click for edit modals. Click the map or search any real place to add stops.
- **Timeline engine** — minute-by-minute simulation per day: departure, routed leg durations (+15% group pace), dwell at every stop, ETAs everywhere.
- **Feasibility studies** — A–F grades per day against hard time gates, fuel range (configurable bike range/MPG), day length, after-dark arrival, and booking status; plus split-point recommendations for loops and overpacked days.
- **AI optimizer** — chat grounded in the live trip state + engine analysis. Proposes structured edits you preview and apply; whole-trip restructures auto-save as named scenarios you can compare and swap.
- **AI-native trip construction** — before a trip exists, the AI researches verified road/fuel/food/lodging/attraction opportunities and has Valhalla measure 2–3 route bundles. Riders inspect the ordered stops and route facts, replace one piece or combine choices in chat, and generate the itinerary only after explicit confirmation.
- **Rider exports** — GPX per day / full trip with planned ETAs baked into waypoint names (on-road schedule checks on any nav device), and an .ics calendar of the whole trip.
- **Ride Mode** — full-screen GPS HUD: live speed, position projected onto the day's route, ahead/behind-plan minutes, next-stop plan-vs-tracking ETAs, gate projections, day progress, screen wake-lock. Installable as a PWA.
- **Persistent AI memory** — the optimizer conversation is stored per trip and survives reloads.
- **Extras** — live weather per day (Open-Meteo), road-status links, budget & fuel module, scenario comparison, undo, JSON export/import.

## Stack

Vite + React 18 · MapLibre GL + OpenFreeMap/Esri tiles · Valhalla motorcycle routing (Google Routes → OSRM fallback) · Google Places/Nominatim geocoding · Open-Meteo · Netlify Functions (streaming NDJSON) · Anthropic Claude (`claude-sonnet-5`).

## Develop

```bash
npm install
npm run dev        # http://localhost:5199
```

The AI features need `ANTHROPIC_API_KEY` and verified place discovery needs `GOOGLE_MAPS_API_KEY` in the Netlify site's environment variables. Functions stream NDJSON responses to stay under Netlify's 10-second synchronous limit — keep it that way. Server-side route comparison reads `VALHALLA_URL` when set and otherwise uses the prototype FOSSGIS endpoint; point it at a self-hosted Valhalla base URL before production traffic. Self-hosted Valhalla needs no account or API key.

## Deploy

Pushes to `main` auto-deploy via Netlify CI (build `npm run build`, publish `dist`, functions `netlify/functions`).

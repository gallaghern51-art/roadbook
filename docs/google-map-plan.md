# Google as the map: plan and mitigations

**The alternative to `mapbox-places-plan.md`.** Draw every map with the Maps JavaScript API instead of mapbox-gl. Every Google data restriction disappears at once (Places, Routes and Geocoding content on a Google map is what the terms expect), so the picker, the place page, verification and the traffic clock stay exactly as built, with our own UI and no Maps link-out. Valhalla keeps the roads: drawing non-Google routes on a Google map is allowed.

**Status (Sep 14, 2026).** Probed with the browser key: the library loads from the dev server, the raster renderer ignores tilt and heading. The vector renderer (tilt, rotation, tappable POIs) needs a Map ID from Map Management (JavaScript, Vector, tilt + rotation). **Blocked on that Map ID** for the one question that decides Ride Mode: whether a vector map tilts over satellite imagery. Everything below assumes the answer is no, because that is what Google's own app does.

## The grammar: Apple Maps' answer

Apple Maps offers satellite, but its driving view is the road map, tilted, in a light or dark scheme. Google's app is the same. So Ride Mode adopts that grammar:

- **Ride Mode navigates on a tilted road map**: three cloud styles, Street, Dark, Light, with Dark the default at night (the app already has the night/day preference). Satellite is available in Ride Mode as a **flat overview** only: pitch 0, north-up, the same look Apple gives you when you switch to satellite while driving. The sheet's basemap segment says so.
- **The plan map and the home map keep satellite as their headline**, flat, which is how they are used today (whole-trip view, tapping places). Terrain relief comes from Google's `terrain` map type, which is a hillshaded road map, the closest thing to our 3D toggle.
- **The chase camera keeps its tuning**: 55° becomes Google's maximum tilt on vector maps (67.5° allowed, 45° typical), heading from the bike, the speed-zoom curve, the puck low in the frame. `map.moveCamera({ center, zoom, heading, tilt })` is the one call; it is not eased, so the 1 Hz glide is ours on animation frames, as the puck already is.

## What ports as-is

- Every engine and the AI builder. Nothing in `src/engine/` knows what draws the map.
- All Google data code: `nearby-places`, `place-details`, `place-photo`, `google-route` (traffic ETA and reroute fallback), `reverse-geocode`, `verify-places`. The residual risk they carry today is gone.
- DOM markers → `AdvancedMarkerElement` with our elements as `content`: PlacePins, RouteShields, the rider dot, the drop-pin needle, RouteWheel's grip (draggable advanced markers exist), stop markers and labels. CSS unchanged.
- The landing frame (`LandingFrame.jsx`): OSM data drawn as SVG, no map library, untouched.
- The Ride Mode HUD, chips, bar, voice, rideNav, distance rulers: all DOM and engine, untouched.

## What changes

| Piece | mapbox-gl today | Maps JavaScript API |
|---|---|---|
| Map creation | `new mapboxgl.Map({ style })` | `new google.maps.Map(el, { mapId, mapTypeId })`, cloud styles per Map ID |
| Basemaps | 4 Mapbox styles + Esri fallback | roadmap (3 cloud styles) · satellite · hybrid · terrain; no fallback needed |
| Route line (glow + casing + core + chevrons) | 3 line layers, gradient by `line-progress` | 3 `Polyline`s with `icons` for chevrons; the done/ahead/beyond split = three polylines re-cut at the bike's along-position each fix (`mercatorCum` already gives the index); or a `WebGLOverlayView` with deck.gl `PathLayer` if the re-cut stutters at 1 Hz |
| Hide native road shields | `hideNativeRoadShields` on symbol layers | cloud style: `road.*` `labels.icon` off |
| Satellite road lift | `liftSatelliteRoads` | none; hybrid's labels are Google's (bolder than Mapbox's) |
| 3D terrain | Mapbox DEM | gone; `terrain` map type for relief |
| POI tap | `queryRenderedFeatures` on `poi_label` | `map.addListener('click', e => e.placeId)` (IconMouseEvent), `e.stop()` to keep Google's own info window closed |
| Traffic | none on the map | `TrafficLayer`, free |
| Camera | `easeTo` / `flyTo` with padding | `moveCamera` / `panTo` / `fitBounds` with padding; eased by us |
| Scale, attribution, logo | Mapbox controls | Google logo + terms links are mandatory and drawn by Google; `ScaleControl` is not offered, we draw our own |
| Long-press drop pin | `mapGestures.js` on the canvas container | same helper on the map div (pointer events; Google's own `contextmenu` on desktop) |
| Sims | `fixtures/mapbox-mock.mjs` answers the style, tiles, sessions | a `google.maps` **stub** served in place of `maps/api/js` (Map, Polyline, AdvancedMarkerElement, LatLng, event) — the API is large; the stub covers what we call. Live checks run with the real key under `RB_LIVE=1` |
| Offline | none | none (unchanged) |

Files: `MapView.jsx` (~1,200 lines, the route layers, drag-to-reshape, leg highlight, picker pins, drop pin), `RideMode.jsx` (map creation, nav layers, gradient effect, camera, puck), `HomeMap.jsx`, `PlacePins.jsx`, `RouteShields.jsx`, `DropPin.jsx`, `RouteWheel.jsx`, `basemaps.js` (replaced by `gmaps.js`: loader, map ids, styles, `poiFromClick`), `mapVis.js` (`viewGate` on `map.getProjection()` / overlay projection).

## Mitigations, one per loss

| Loss | Mitigation |
|---|---|
| Tilted satellite in Ride Mode | Ride on the tilted road map (Apple's grammar); Dark at night; satellite as a flat overview one tap away |
| 3D terrain | `terrain` map type on the plan map; Ride Mode does not need relief at speed |
| Beartooth hairline on satellite | hybrid's own labels; the route line is drawn by us and stays legible |
| Line gradient | three polylines re-cut per fix (cheap: one `slice` on the geometry) |
| Free tier 10k loads vs 50k | one map instance per screen, reused across trips (already the pattern); Ride Mode is one load per ride; the home and plan maps are one load per app open |
| Custom vector styling | cloud styles editor covers dark/light/shield-hiding; anything finer is out |
| Esri fallback when a style fails | not needed; Google serves its own tiles |
| The Mapbox wordmark/ⓘ work | Google's logo and terms links replace them; same corner discipline |

## Phases

1. **`gmaps.js` + HomeMap** (2 days). Loader, Map IDs (dark/light/street), the click→POI adapter, `RiderDot` and `PlacePins` on advanced markers, long-press on the map div. Home is the smallest map and exercises markers, POI taps and the sheet layout.
2. **MapView** (4 days). Routes as polylines with chevrons, per-day colours, casing, whole-trip vs day view, drag-to-reshape (mousedown on a polyline → the rubber band), RouteWheel, leg highlight, picker pins, drop pin, shields, fitBounds with padding.
3. **RideMode** (4 days). The nav map, three-zone line by re-cut polylines, chase camera on `moveCamera` with our easing, north-up toggle, overview, live reroute redraw, quick-add pins, traffic layer, basemap segment (Street/Dark/Light + flat Satellite).
4. **Sims** (3 days). The `google.maps` stub, every map sim re-pointed, a live pass with the real key on the iOS simulator.
5. **Cleanup** (1 day). mapbox-gl and the Mapbox token out of the app (the landing never needed it); legal.js processors; credits; CLAUDE.md.

About three weeks. The Map ID probe first; if satellite tilts on vector after all, phase 3 keeps the satellite chase view and this plan gets better, not different.

## Cost
Maps JavaScript API: Dynamic Maps SKU, 10,000 free loads per month, then ~$7 per 1,000. Traffic layer free. Advanced markers free. Places, Routes, Geocoding unchanged from today. The Mapbox bill goes to zero.

## Risks
- The vector renderer's tilt limits and performance on older phones are unmeasured here.
- Polyline re-cutting at 1 Hz on a 1,500-vertex day: cheap in theory, to be measured on a phone.
- Google's info windows and POI behaviour have to be suppressed everywhere we handle a tap ourselves.
- A vendor with a history of pricing changes owns every layer of the app.

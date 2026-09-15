# Pure Mapbox plan: places, routes, geocoding off Google

**Why.** Google's Maps Platform Service Specific Terms forbid using Places (§14.2), Routes (§19.2) and Geocoding (§6.2) content "in conjunction with a non-Google map". Roadbook draws Google Places pins on a Mapbox map. Tesla runs the same pattern under a negotiated contract; the self-serve terms do not allow it. Mapbox data on a Mapbox map raises no such question.

**Decision (owner, Sep 14, 2026).** Move places, the traffic clock and reverse geocoding to Mapbox. Keep Valhalla for the roads. Keep Google running in the app until each phase replaces it; de-brand the verification vocabulary now.

**Preview built (Sep 14, 2026).** Phases 1, 2 and 4 run behind a device switch — Settings → Map → Place data (`placeData`), or `?places=google|mapbox` — with **Mapbox the default on this branch** and Google the opt-in for comparison. Decide the default again before merging to main. `src/engine/mapboxPlaces.js` answers in the Google row shape straight from the browser with the public token; `src/engine/placesProvider.js` is the switch plus the stamp helpers (`verified: 'mapbox'`, Mapbox ids never sent to Google). In Mapbox mode the picker, the home pill and POI tap, the place page, the dropped-pin name, the geocode box and Ride Mode's traffic clock make no Google call, and `googleRoute` refuses (Valhalla → OSRM carries reroutes). **Not in the preview:** Phase 3 — the AI builder and planner still search and verify with Google server-side (it needs a server token), and the Google functions are not deleted. Verified: `scripts/mapbox-places-check.mjs` 47/47 (37 pure + 10 live), and in the browser on :5199 an along-route Fuel search over the Sturgis template → Mapbox rows with off-route/ahead, open-now and the fuel verdict → Mapbox Details page (★ rating, 24 h, amenities, "Place facts from Mapbox") with zero calls to the Google-backed functions. **Details cost:** the Details API is a *private* preview priced per request by attribute set, so the place page asks for `basic,venue` only — `visit` (hours, phone, website) already arrives on the Search Box row the page opens from, and `photos` returned nothing in MT/WY/SD; measured Sep 14, 2026, `basic,venue` gives the same rating, description and amenities as all four sets. On a desktop the page opens straight away (one Details request per place opened); on a phone it waits for the Details tap.

**What the coverage test said (Sep 14, 2026).** All 119 Google-verified places from the two templates through Mapbox Search Box: about 90% of businesses found once towns use `types=place` (Montana 50/63, Wyoming 19/23, South Dakota 18/20 raw; coordinates agree with Google to a median 220 ft). Hours on most, phone on most. **Zero ratings, price levels or photos anywhere in the region**, including 25-result city searches. Hotels arrive duplicated per room type. Places Details (preview) answers our token: reality/closed scores, a driving routable point, OSM-style hours, attributes.

## The stack after the move

| Need | Today | After |
|---|---|---|
| Road choice (plan, Ride, reroute) | Valhalla motorcycle → Google → OSRM | Valhalla motorcycle → OSRM |
| Traffic ETA anchor (10 min, time only) | Google Routes | Mapbox Directions `driving-traffic` |
| Dropped-pin road name | Google Geocoding + Places Nearby | Mapbox Geocoding v6 reverse |
| Place search (chips, pill, POI tap, Ride quick add) | Google Places (New) via `nearby-places` | Mapbox Search Box `/forward`, `/category`, `types=place` for towns |
| AI stop verification | Google Places strict types | Search Box name-first → category fallback; Places Details reality/closed score where quota allows |
| Place page | Google Place Details + photos | Search Box retrieve + Places Details: hours, phone, website, categories, attributes, website photos, busyness |
| Ratings, reviews, price | Google | **Gone.** Rows and the page lead with Roadbook's own facts (distance, open at ETA, cuisine, detour, gate margin, fuel verdict) |

## Phases

### Phase 0 — vocabulary (now, no behaviour change)
- `✓ Google` → `✓ Verified`; "Checking with Google…" → "Checking the listing…"; "No Google listing found" → "No listing found". These are Roadbook's own stamps, not Google content.
- Keep the "Place facts from Google" attribution lines wherever Google data is actually displayed: Places' terms require them while it is in the app. They go with Phase 4.

### Phase 1 — the clock and the name (1 day; closes Routes + Geocoding)
- `trafficEta` → Mapbox Directions `driving-traffic` over the remaining stops, time only (client, public token).
- `routeFrom` and `routeDaySteps`: delete the Google fallback (Valhalla → OSRM). Delete `google-route.mjs`.
- `reverseGeocode` → Mapbox Geocoding v6 `/reverse` (street/locality types). Delete `reverse-geocode.mjs`.
- Sims: `traffic-anchor-check` (mock Mapbox Directions), `valhalla-check` (no Google call counting), `pin-drop-check` (mock Geocoding v6).

### Phase 2 — search (2–3 days)
- `nearby-places` keeps its RESPONSE SHAPE (name, lat, lng, placeId→`mapboxId`, primaryType, rating→null, price→null, periods, openNow, address) so NearbyPicker, HomeSearch, PoiCard and RideQuickAdd change little. Behind it: Search Box.
  - category → Search Box category ids (`gas_station`, `restaurant`, `cafe`, `hotel`, `tourist_attraction`, `motorcycle_dealer` + `motorcycle_repair`, `hospital`); cuisine sub-chips → category ids (`pizza_restaurant`, `barbeque_restaurant`, `mexican_restaurant`, `steakhouse`, …).
  - free text → `/forward` with `proximity`; towns → `types=place`.
  - **along the route**: Mapbox has no Search Along Route. Sample the day's corridor every ~15 mi, category-search each sample (limit 5, ~10 mi), dedupe by `mapbox_id`, then `enrichAlong` measures off-route/ahead as today. Google's routing summaries go; `detourCost` (Valhalla, one tapped row) already answers that.
  - POI tap (`usePoiMatch`): `/forward` by name with a tight proximity, first hit within 0.3 mi.
  - hotels: dedupe rows that share a name within 200 m (room-type feeds).
- Rows drop ★ and $; cuisine tag comes from `poi_category_ids`; open-at-ETA reads `metadata.open_hours.periods` (same shape as Google's).
- Sims: a `mapbox-search-mock.mjs` fixture replaces the Google mocks in nearby, home-map, place-pins, poi-tap, quick-ride, live-nearby.

### Phase 3 — verification (2 days)
- `verify-places.mjs`: Search Box name-first within the spec radius, then category fallback ("what is actually here"); stamp `verified: 'mapbox'` + `mapboxId`; existing `verified: 'google'` stops stay as they are (nothing retroactive).
- Places Details for the reality/closed score on fuel and lodging only, budgeted (preview quota 1,000 records/month per account; cache per build).
- `tools/verify-seed.mjs` regenerates `seedPlaces.js` / `earlyExitPlaces.js` against Mapbox. Expect ~6 businesses to fall to placed/unverified (Loud American Roadhouse, Fairfield Inn Missoula Airport, Town Pump Billings…).
- Planner prompt: "verified" no longer means Google; the rule is unchanged (never emit a coordinate you cannot name).

### Phase 4 — the place page (2 days)
- PlaceSheet on Search Box retrieve + Places Details: hours table, phone, website, address, categories → cuisine, attributes → amenity chips (wheelchair, outdoor seating, takeout, price_level as a word), website photos, busyness-by-hour where present. No ratings, reviews or editorial summary.
- Attribution line becomes "Place facts from Mapbox". Details quota: one record per open, cached per page load; submit Mapbox's expanded-access form with the coverage numbers.

### Phase 5 — Google out (1 day)
- Delete `google-places.mjs`, `nearby-places.mjs` (Google half), `place-details.mjs`, `place-photo.mjs`, `places-core.mjs`, `GOOGLE_MAPS_API_KEY`, `VITE_GOOGLE_MAPS_KEY`.
- `legal.js` privacy processors list, Settings → About credits, CLAUDE.md, the landing's "verified with Google" copy if any.

## Cross-cutting
- **Storage licence.** Both Mapbox Search Box and Places say results are for temporary use; a verified stop saved into a trip is stored location data. File Mapbox's expanded-access form (Places) and ask sales about storage in the same message. (Google's equivalent, 30 days for coordinates, was already being exceeded.)
- **Token.** The public `pk.` token covers Search Box, Geocoding, Directions and Places from the browser; it is URL-restricted. A server token is only needed if Details moves server-side to protect the quota.
- **Cost.** Search Box category/forward are per request; Directions per request; Geocoding per request. All inside Mapbox's free tiers at beta volume.
- **Own Valhalla** (Docker + US extract) is the routing upgrade that removes the 10-stop cap; independent of this plan.

## Risks
- No star ratings anywhere in the region: riders lose ★ on rows and the page. Mitigation: Roadbook facts lead, busyness score where present.
- Along-route search is sampled, not true corridor search: slightly more calls, results within ~10 mi of the line.
- Hotel duplicates and a handful of rural misses (see the test). Verification falls back to "placed" honestly rather than inventing.
- Places Details is Public Preview: contract may change; keep it behind one adapter.

# Roadbook — Feature & Information-Architecture Audit

*Walked live at https://sturgis-2026-trip.netlify.app on August 1, 2026 — desktop (1280×720) and phone (375×812) widths, every tab, the New-trip modal, Ride Mode, and one real production AI request. Companion to [market-assessment.md](market-assessment.md).*

---

## Verdict

Roadbook is a planning instrument of unusual depth wearing the information architecture of a single-trip field guide. Surface by surface, the feature depth is ahead of every competitor. What needs restructuring is the *arrangement*: a flat seven-tab bar that ranks the AI brain equal to a preferences page, a "Dashboard" that is actually a file cabinet, three separate doors into one AI, and a first run that drops a stranger into somebody else's Sturgis trip with no framing. The parts are strong; the shelving is stage-one.

---

## Surface-by-surface assessment

Grades are for *functional utility as built*, judged against what a paying rider would need.

### Map — A−
Phase-colored routes with direction chevrons, glow/casing, real highway shields, waypoint labels in edit mode, six basemaps + 3D terrain, imperial scale, legend, hover-for-leg-info, whole-trip vs. day-edit modes. Nothing in the category renders routes this well.

**Fragile first impression:** a cold visitor sees a black rectangle (satellite tiles), then bare dots while all days route through Valhalla sequentially. The routing-progress chip now makes that work visible; skeleton polylines remain a possible refinement if cold-start latency still reads as broken in field testing.

### Day ribbon — A
The app's true spine: always present, every day's date/number/title/miles/hours, warning dots, selected-state. It *is* the trip's table of contents and it survives every view. Keep it central in any restructure.

Nit: the ★ on certain days (anchor days) is never explained anywhere in the UI — the legend explains phase colors and marker types but not the star or the red dot.

### Dashboard — C+
The two status chips — `B · 86/100 · 2 days need attention` and `4 open · Reserve these now`, both deep-linking — are the best thing on the page and the germ of a real dashboard. Everything else is a file cabinet (New / Scenarios / Export / Import / Reset). No countdown, no next-actions list, no weather flags, no packing progress, no per-day strip. The page holds the *least* content of any tab yet occupies the home seat. (The redundancy audit that emptied it was correct — the launcher cards were duplicates — but what should have back-filled the space never arrived.)

### Planner (trip overview) — B+
"The whole trip at a glance": stat chips, summary, drag-to-reorder day list with phase color bars and per-day mi/hrs, Add day below the fold. Clean and correct. Reserve-now list lives here too (reached by the Dashboard chip). This page and the ribbon overlap almost completely — the overview earns its place through reorder/add, but on desktop it's two renderings of the same list an inch apart.

### Day editor — A
The deepest single surface in the category, by a wide margin: timed stop list (ETA + leg time + cumulative miles per stop), drag-to-reorder, tap-to-zoom, per-stop detail/delete, fuel stops with dwell minutes **and named backup stations**, photo stops with best-light/parking/hazard notes, food modules with named restaurants and fallbacks, lodging with booking status and check-in intel, day conditions (Open-Meteo, positioned at a mid-day waypoint), depart-time editor with live end-time, per-day GPX export, highway shields inline. This is what "plans trips, not routes" looks like — a Rever route card holds maybe 10 % of this.

Costs of the density: on a phone it's a long wall; the editing affordances hide behind small glyphs (⠿ ⓘ ✎ ✕) with a one-line legend; "OPTIONAL MODULES" is developer vocabulary on a rider surface.

### Optimizer (AI chat) — A− capability, C− placement & naming
Verified live on production: asked for a feasibility read, got back an analysis quoting *exact* gate ETAs and margins ("St. Mary gate target 8:30 AM; projected ETA 9:38 AM", "Needles Hwy: 11 minutes of margin", "Piccola staging: 4 minutes"), correctly separating routing failures from booking failures, citing the engine's own split points, and identifying the one day a route change can actually fix. No competitor can produce a paragraph of that answer. The empty state is good (capability statement + four one-tap prompts).

Problems: **(1) Naming** — "Optimizer" sells a solver utility; this is the product's brain and the market pillar. **(2) Placement** — it's the third of seven equal tabs; a brain that reads and edits every other surface is presented as a sibling of Packing. **(3) Latency theater** — ~50 s on the background transport with only a quiet spinner; the NDJSON protocol already carries `building`/progress events that the UI could narrate ("reading feasibility… drafting changes…"). **(4) Findings are prose** — day names in the answer should be chips that deep-link to the day or highlight it on the map.

### Feasibility — A
The differentiator, fully realized: overall grade + score, per-day graded cards, gate warnings with margins to the minute, after-dark arrival warnings with wildlife context, unbooked-lodging warnings, split-point recommendations with mileage fore/aft, loop-break advice with a decision protocol, and a per-warning **"Have the Optimizer restructure it →"** handoff. This page is the marketing. It's also proof the deep-link pattern (status → owning surface → AI) is the app's native grammar — extend it everywhere.

### Budget — B
Fuel computed from routed miles (day-by-day gal/bike and cost), all assumptions adjustable, per-rider and per-group totals, sensible advice lines. Honest and useful. Gaps: lodging is a flat $/night even when the trip knows actual bookings; single currency despite a bilingual crew; no what-if link to the AI ("cut $300/rider" is exactly an optimizer prompt).

### Packing — B−
Progress counter, categories, add-item, per-device checking with an honest label. The content is superb *seed content* (visor types, altitude sun, evac-insurance line) — but it's static: a new AI-generated trip doesn't derive its list from route altitude/weather/duration, and there's no group visibility of who's packed. Fine v1; the AI-derived list is the obvious upgrade.

### Settings — A−
Language / theme / units, honest data credits, dev tools tucked away. Correct scope, minimal. Doesn't need a top-level seat.

### Ride Mode — B+ (within browser limits)
Graceful GPS-denied banner while still showing the plan (depart time, first waypoint); leg picker, map settings, End navigation in the menu; HUD with next-stop; route drew correctly over satellite. The ceiling is structural, not design: a browser tab with the screen on. Native wrapper (Phase 2 of the GTM plan) is where this surface becomes real. Cold-open on desktop showed black until tiles arrived — same first-impression fragility as the main map.

### Trip file operations — D
`prompt()` / `confirm()` native dialogs run scenario naming, trip switching (type a number from a numbered list), and reset. Scenarios — a genuinely differentiating feature — are invisible until you trigger a browser prompt. JSON export/import is the only way a seven-rider crew shares the plan today. Disqualifying for a paid product; cheap to replace with real sheets/pickers.

### i18n — A (unique)
Language switch triggers visible auto-translation with a progress pill; AI answers in the asker's language. No competitor has this. Under-leveraged as a marketing fact.

---

## Information-architecture findings

1. **Seven equal seats for unequal things.** Dashboard (status), Planner (workspace), Optimizer (an agent), Feasibility (a report), Budget (a report), Packing (a checklist), Settings (preferences) — one flat rank. The agent belongs *everywhere* (docked), Settings belongs *nowhere* (an icon), and the reports are aspects of the plan, not peers of it.
2. **Three doors to one brain.** Optimizer tab, per-warning feasibility handoffs, New-trip AI Builder — all reach the same planner core, no door is omnipresent, and the tab door is the weakest framing of the three. The AI should be a persistent companion surface (docked panel / slide-over with context chips), not a destination you travel to.
3. **The home seat holds the least.** See Dashboard above. Either the status board grows into the seat, or the seat goes to the map/overview.
4. **First run is the biggest gap.** A cold visitor lands *inside a stranger's 11-day trip* — no welcome, no "this is a template you can remix," no path to "make mine." The AI Builder modal — the exact right intake, with name/date/days/riders + description and a strong placeholder — exists but sits three levels deep (Dashboard → Trip file → New trip → AI Builder tab). For go-to-market this modal, essentially unchanged, *is* the front door.
5. **Single-trip identity leaks.** Hardcoded crew/state flags in the masthead, "LA EXPEDICIÓN CHILENA" eyebrow, ★ anchor days, `sturgis-2026-trip.json` export name. Charming for the crew; alien to a new user; contradicts the multi-trip library the store already supports.
6. **The deep-link grammar is right — finish it.** Status chips → owning page; feasibility warning → AI handoff; ribbon dots → day. Extend to: AI answers (day chips), budget overruns, packing gaps, ribbon grade badges.
7. **Phone layout verdict.** The one-surface bottom bar works and the panel-over-map slide is good. Costs: ~40 % of the bare-map screen is floating chrome (masthead + ribbon + basemap row); 4 of 7 seats visible without scrolling; the day-editor wall. The map-peek at the panel's left edge is a nice touch worth keeping.
8. **Nomenclature.** "Optimizer" (undersells the brain), "Feasibility" (ownable, but lead with the grade), "Scenarios" (invisible feature, browser-prompt UX), "Trip file" (file-cabinet framing on the home surface), "Optional modules" (developer vocabulary).

---

## Feature gaps the walk-through exposed

Beyond the infrastructure gaps in the market assessment:

- **Ride-quality routing preferences — partially resolved Sept 6, 2026.** Trip settings now offers Quick / Touring / Back roads plus toll avoidance, stored on the shared trip and applied through Valhalla to Plan geometry, Ride maneuvers, and live reroutes. The remaining competitive gap is a genuine curvature/road-quality score: Back roads strongly reduces highway use but must not be marketed as a true “twisty” optimizer yet.
- **No shareable artifact.** No trip link, no read-only view, no printable day sheet / roadbook PDF. For the founding seven-rider crew, JSON import is the only distribution. The share page is also the growth loop and the SEO surface — highest-leverage single feature in the whole plan.
- **No POI/discovery layer** for hand-building days (passes, byways, moto-POIs, "best roads near me"). Defensible to defer; the AI's `search_places` partially substitutes.
- **No progress narration** for the two long waits (first route load, AI runs) — both protocols already emit the events; the UI just doesn't tell the story.
- **No onboarding, no help** anywhere.

---

## Reorganization blueprint

Concrete target consistent with the market assessment's Phase 1:

- **Home** = trip library (cards with grade badges) + **"Describe your trip"** AI intake + template gallery (Sturgis becomes a template card, not the default state).
- **Inside a trip, three modes:** **PLAN** (map room: ribbon + overview/day editor + docked AI), **PREP** (the real dashboard: grade hero, countdown, reserve-now, budget summary, packing progress, weather flags — each chip deep-linking), **RIDE** (unchanged). Settings becomes an icon.
- **AI docked everywhere** in trip context — one door, always open, with context chips ("about Day 3") and answers that link back to days/stops.
- **Feasibility dissolves into the grade system** — badges on ribbon cards and trip cards, hero card on PREP, full study one tap deep. The report page stops being a destination and becomes the proof layer.
- **Replace every `prompt()`/`confirm()`** with real sheets (scenario save/picker, trip switcher, reset).
- **Ribbon stays the spine** across PLAN and PREP.

Sequencing note: everything above is view-shuffling over an unchanged engine — the op/store architecture doesn't move. The two long-lead items (routing preferences, share pages) are engine/backend work and are already phased in the market assessment (Phases 0–2).

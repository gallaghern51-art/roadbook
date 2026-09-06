# Roadbook — Market Assessment & Go-to-Market Course of Action

*Prepared August 1, 2026. Codebase assessed at commit a3d3340.*

---

## 1. Verdict

Roadbook can win a real position in this market, but not as "another route app with AI sprinkled on." The winning claim is: **everyone else draws routes; Roadbook plans trips.** No competitor — Rever, Calimoto, Scenic, Kurviger — simulates a riding day minute-by-minute, grades feasibility, checks fuel range against the bike, budgets, packs, or lets an AI negotiate the plan through the same operations a human editor uses. That engine is the moat. The current gaps are almost entirely *infrastructure* (accounts, sync, native app, licensed services, metered AI), not product insight.

The course of action below gets to a chargeable product in ~4–6 weeks and a marketable one in ~5–6 months.

---

## 2. What you have (asset assessment)

~8,500 lines of app source. Small, clean, and unusually well-architected for its size.

**Genuinely differentiated assets:**

- **The op-based engine** (`src/engine/ops.js`, `store.js`) — every trip mutation is an op; the UI and the AI emit the same vocabulary. This is the architectural moat. It's what makes "AI as a first-class editor" real: AI edits are precise, describable, undoable, and scenario-savable. A competitor bolting a chatbot onto Rever cannot match this without rebuilding their state layer.
- **The feasibility engine** (`timeline.js`, `tripEngine.js`, `splits.js`) — minute-by-minute day simulation, hard-gate checks, per-day grades, fuel-gap warnings against actual bike range, break-point recommendations. **No competitor has anything like this.** This is the "wow" that survives a demo.
- **A production-shaped AI planner** (`netlify/lib/planner-core.mjs` + three transports) — streaming NDJSON, background jobs with progress, agentic place search with verified coordinates, digest-based grounding so the model reasons from real routed numbers. This is serious engineering, not a wrapper.
- **Ride Mode** (`RideMode.jsx`, ~1,000 lines) — map-matched puck, live rerouting, voice guidance, traffic-aware ETAs (Google), plan-delta tracking, tile prefetching. Deep for a web app.
- **Whole-trip scope** — budget, packing, bookings ("reserve these now"), scenarios, GPX with planned ETAs, ICS export. Trip breadth no route app has.
- **EN/ES i18n with auto-translation** — nobody in the category serves bilingual group trips. The founding use case (US + Chilean riders) is itself an underserved market: LatAm riders touring the US.

**Gaps that block market entry (ranked):**

1. **No accounts, no server persistence.** Everything lives in localStorage. Clearing browser data destroys a user's trips; nothing syncs between phone and laptop. You cannot charge money for this. *Gap #1 by a mile.*
2. **The AI endpoints are open and unmetered.** `/.netlify/functions/chat` and `planner-background` accept any POST from anyone and spend your Anthropic key ([chat.mjs](../netlify/functions/chat.mjs) has no auth, no rate limit). The Google key behind `google-route`/`google-places` has the same exposure. The moment the URL circulates, someone scripts it. **Do not market the current deployment.**
3. **Free public services in the production path, with no commercial SLA.** Valhalla motorcycle routing currently uses the FOSSGIS community endpoint, OSRM's demo server remains the last routing fallback, geocoding can fall back to Nominatim, and the default basemaps include Esri ArcGIS Online endpoints. Fine for prototyping; self-host or license each production path before commercial traffic.
4. **No native app.** Navigation needs background GPS; a browser tab must stay foregrounded with the screen on. Rever's most common complaints are nav reliability and crashes — a PWA is structurally *worse* at exactly that. App Store / Play Store presence is also where riders discover this category. (Capacitor is already on the roadmap — correct call.)
5. **No offline maps** — a top-3 paid feature in every competitor.
6. **Single-user trips.** The product was built *for* a 7-rider group and has no shared trip. Group sharing is both the killer use case and the viral loop.
7. **No track recording / ride history** — table stakes for the tracking crowd, and the raw material for a personalization moat (see §7).
8. Cosmetic Sturgis DNA: hardcoded crew/state flags in the masthead, `sturgis-2026-trip.json` export name, `sturgis.*` localStorage keys. Cheap to fix, signals template-ness.
9. No tests/types/CI beyond the i18n check. Fine at 8.5k lines; add engine tests as it grows (the pure-function engine makes this easy).
10. **Naming risk:** "roadbook" is a generic term in rally/moto navigation (rally roadbook readers already exist as products). Likely hard to trademark; run a search before spending on brand.

---

## 3. The market

**Size.** ~8.8M registered on-road motorcycles in the US (2023, more than doubled since 2002); touring bikes are ~23.5% of registrations — call it ~2M touring machines, plus the fast-growing ADV segment. US motorcycle market ≈ $10.5B (2024), growing ~4%/yr. Sturgis alone draws ~500–750k riders every August. The buyer persona for Roadbook — plans multi-day trips, often organizes for a group — sits squarely in the highest-spend segment.

**Competitors:**

| App | Price | Strength | Weakness |
|---|---|---|---|
| **Rever** (Comoto/RevZilla-owned) | $39.99/yr | Biggest community, millions of shared routes, group rides, LiveRIDE tracking; 1M+ downloads, 4.5★ | Nav reliability/crash complaints, paywall creep, CarPlay problems, retention struggles; corporate-owned, slow-moving |
| **Calimoto** | ~$40–79/yr | Best curvy-road routing algorithm | EU-centric, route-only scope |
| **Kurviger** | €15–30/yr | Deep route customization | EU-focused, dated UX, route-only |
| **Scenic** | ~$60/yr | iOS polish, CarPlay/Android Auto | Small team, route-only |
| **Komoot** | freemium | Just added ChatGPT route generation (2026) | Bicycle/hiking-first; AI is a text-to-route wrapper |
| **AI entries** (rides4you, custom GPTs) | — | "AI" positioning | Thin wrappers, no engine, no nav, no persistence |

**The opening.** Every incumbent is a *route* product: draw a line, follow it, log it. None plans the *trip* — days, dates, lodging, fuel stops sized to the bike, schedule gates, budget, packing, the group. The AI entries that exist are prompt-wrappers with no engine underneath. Komoot's ChatGPT move signals the category is about to get "AI-washed" — the way to survive that is to own the *depth* claim (AI that edits a simulated, feasibility-graded plan) before Rever bolts a chatbot on. Speed matters; the architecture advantage (ops + simulation) is real but the positioning window is now.

---

## 4. Positioning

**"The AI trip planner for motorcyclists. Describe the ride; get a routed, fuel-checked, feasibility-graded, day-by-day plan — then negotiate it."**

- **Pillar 1 — AI concierge** (the demo): "Denver to Sturgis and back, 7 riders, 6 days, avoid slab, we like national parks" → watch the trip build live on the map, graded and dated. Then: "make day 3 shorter," "what if we leave Saturday?" → scenario diff.
- **Pillar 2 — The feasibility grade** (the trust): every trip wears a grade. "B+ · 2 days need attention" is a shareable, screenshot-able artifact no competitor can produce.
- **Pillar 3 — The group** (the growth): one organizer plans; the crew joins by link, sees the plan, RSVPs, gets the packing list. Every group trip recruits 5–10 viewers who are next year's organizers.

Do **not** fight Rever on community/route-discovery at launch — that's their moat (millions of routes, network effects). Interop instead: GPX in/out means riders can plan in Roadbook and ride anywhere, until Ride Mode earns the day-of job too.

**Wedge audiences** (in order): group-ride organizers ("road captains"); bucket-list/rally trips (Sturgis, Blue Ridge, Tail of the Dragon, moto-rental tourists); bilingual/international groups touring the US (ES is already built — genuinely nobody serves this).

---

## 5. The structural question (you asked)

You're right to question map-under-everything. It's a *planning-room* UX from when the app held exactly one trip. It's correct **inside** a trip and wrong as **app-wide chrome**. The app has three jobs, months apart in time; they shouldn't share one surface:

- **PLAN** (months before): map + chat + day list, side by side. The current planning room is good — keep it. This is where map-always-visible belongs.
- **PREP** (weeks before): no map needed. The Dashboard today is a file drawer (New/Import/Export/Reset), not a dashboard. Rebuild it as the trip's status board: countdown, feasibility grade, open bookings, weather flags, packing progress, crew RSVPs — glanceable chips that deep-link. This becomes the screen an organizer checks daily the week before.
- **RIDE** (day of): already its own fullscreen surface. Correct.

And above all three: **Home = the trip library + AI intake**, not a map of nothing. First launch should open on "Where do you want to ride?" — a chat box and your trips, like a streaming app opens on your shows, not on a TV test pattern. The map earns the screen when there's a trip on it. This restructure (App → Home → Trip{Plan, Prep, Ride}) is Phase 1 work and it's mostly rearrangement, not rebuild — the pages already exist as views.

---

## 6. Course of action

### Phase 0 — Make it chargeable and defensible (weeks 1–4)

1. **Supabase auth + trip sync.** You already run Supabase elsewhere. The op architecture is a gift here: sync the *op log* per trip, not blobs — conflicts nearly vanish for the common case, and undo/scenarios come along free. localStorage becomes the offline cache instead of the database.
2. **Gate and meter the AI.** Functions require a session token; per-user daily/monthly token budgets (the budget plumbing in `planner-core.mjs` is half the work); IP rate limits for the unauthenticated surface. Same gate in front of the Google proxy functions.
3. **License the production path.** Self-host OSRM or Valhalla for planning routes (a US extract on a small VM, ~$20–50/mo) or use a paid tier (Stadia, GraphHopper). Replace the raw Esri endpoints with licensed tiles (MapTiler/Stadia/Protomaps — or commit fully to Google tiles since sessions are already built). Move geocoding primary to the already-built Google Places function; keep Nominatim only as a dev fallback.
4. **Name check.** Trademark search on "Roadbook" before buying brand equity; have a fallback.
5. Scrub Sturgis DNA (flags, filenames, key names — keep the trip as the beloved template).

### Phase 1 — The demo moment + restructure (weeks 4–10)

1. **Home = library + AI intake** ("Describe your trip"); Trip = Plan / Prep / Ride as above.
2. **Sharpen generate mode into the marketing asset:** short multi-turn intake (bike, dates, riders, pace, interests) → streaming build with the route drawing live on the map → grade reveal. This 45-second clip is the entire ad.
3. **Shared trips v1:** invite link; organizer edits, crew views + RSVPs + sees packing list. (Supabase row-level security makes viewer-role cheap.) This is the growth loop — ship it before community features, before track recording, before everything optional.
4. **Feasibility as the hero:** grade badge on every trip card, share-able plan page (public read-only trip URL — also the SEO surface).

### Phase 2 — Own the ride day (weeks 10–20)

1. **Capacitor wrapper** → App Store / Play Store, background GPS, wake-lock done right. Store presence is credibility in this category, not just distribution.
2. **Offline packs:** pre-download the trip corridor's tiles + routes (the cache discipline already exists; make it a deliberate "Download trip" button). Top paid-feature in every competitor.
3. **Track recording + "did the plan hold?"** post-ride replay of actual vs plan (the `planPosition` math already exists). This is the unique take on tracking — and recorded pace feeds the AI's model of *your* group's real pace, which compounds into a personalization moat nobody can copy from a standing start.
4. CarPlay/Android Auto: acknowledge, schedule later — it's Rever's sorest complaint, but it's a big lift; offline + background GPS first.

### Phase 3 — Monetize and launch (overlaps; GA ~month 5–6)

**Pricing** (anchors: Rever $39.99, Scenic ~$60, Calimoto up to $79):

- **Free:** 1 active trip, manual planning, limited AI (e.g., 10 AI actions/mo), GPX export, day-of ride mode.
- **Pro — $59.99/yr or $7.99/mo** (founding-year $39.99 to undercut Rever head-on): unlimited trips, full AI concierge, offline packs, shared trips, traffic ETAs, scenario history.
- Stripe for web billing. Sell subscriptions on the web to keep Apple's 15–30% off the majority of revenue (US anti-steering rules now permit external purchase flows); add IAP later only if store conversion demands it.

**AI unit economics** (Sonnet 5): a heavy planning session runs ~100–200k tokens ≈ $0.50–1.50; a Pro user doing 3–4 sessions/mo costs $2–6 worst case, against $5/mo revenue — workable with quotas, prompt caching on the trip context, and the digest discipline you already have. The existing budget/`BUDGET_MS` plumbing becomes per-plan quotas.

**Cost watch-list:** Google Routes is now an outage fallback rather than the route owner; retain quotas in case Valhalla is unavailable. Also watch Google tiles past 100k/mo and Anthropic spend per free user (cap hard).

**Launch motion:**
- **SEO/content flywheel:** publish AI-generated plans for iconic rides as public trip pages ("Sturgis from Denver, 6 days", "Blue Ridge Parkway long weekend", "Tail of the Dragon loop") — each page is a living demo with a grade badge and a "remix this trip" button.
- **Rally-timed pushes:** Daytona (March), Sturgis (August) — the category's two demand spikes.
- **YouTube moto channels** — this category converts through a handful of reviewers; seed Pro accounts.
- **Partnerships:** rental fleets (EagleRider), tour operators, HOG chapters — group organizers concentrated in one place. The ES/bilingual angle is a genuine hook for LatAm inbound-tour operators.
- Reddit/forums (r/motorcycles, ADVrider) — show the feasibility grade, not an ad.

**Legal before GA:** LLC, ToS + privacy policy (accounts ⇒ CCPA/GDPR basics), and a navigation-app liability disclaimer at first Ride Mode launch.

### Phase 4 — Moat building (months 6–12)

- Publish/remix community trip templates (attack route-discovery *sideways* — whole trips, not road segments).
- Pace personalization from recorded rides (AI learns your group's real mph, dwell habits, fuel anxiety threshold).
- Weather-aware replanning: push "storm crossing day 3 — here's the reroute" (conditions engine exists in `conditions.js`).
- Group live location on ride day (Rever LiveRIDE parity, but plan-aware: "Marco is 12 min behind plan").
- Affiliate revenue: lodging links on overnight waypoints (Booking/Expedia), gear links on the packing list — RevZilla makes money on gear; so can the packing list.

---

## 7. Risks

| Risk | Read |
|---|---|
| Rever adds an AI chatbot | Likely within 12–18 months. Theirs will be a wrapper (their state layer isn't ops); yours edits a simulation. Win by shipping the positioning *now* and making the feasibility grade the visible proof of depth. |
| Solo/small-team bandwidth | The phases are sized for 1–2 devs + AI tooling. The codebase being 8.5k lines of mostly-pure functions is the speed advantage — protect that discipline (engine stays pure, add tests as it grows). |
| API costs at scale | All three exposures (Anthropic, Google Routes fallback, tiles) are quota-able; Phase 0 metering is the fix. Planning and Ride routing are designed around self-hosted Valhalla motorcycle costing, with hosted fallbacks for resilience. |
| App Store 30% | Web billing first; IAP only if data demands. |
| Name collision | "Roadbook" is generic in moto rally; search before brand spend. |
| Category is niche | Yes — and that's fine. 1,000 Pro subs ≈ $40–60k ARR year one is a realistic beachhead; Rever proved 1M+ downloads exist here. The group-viewer loop and public trip pages are the compounding channels. |

---

## 8. Sources

- [REVER pricing/features review, 2026](https://marlvel.ai/apps/com-reverllc-rever) · [REVER user reviews / complaints](https://justuseapp.com/en/app/975571447/rever-gps-discover-planner/reviews) · [Comoto acquires REVER (2020)](https://www.businesswire.com/news/home/20201114005116/en/Comoto-Holdings-Acquires-REVER-the-Worlds-Largest-Motorcycle-Off-road-and-Adventure-GPS-App-and-Community-to-Further-Expand-the-Comoto-Family-of-Brands)
- [2026 app comparison — MotoVault](https://motovault.app/blog/best-motorcycle-trip-planner-apps) · [motobit top-5](https://www.getmotobit.com/the-5-best-motorcycle-apps/) · [SlashGear roundup](https://www.slashgear.com/1755865/motorcycle-apps-find-routes-track-rides/)
- [calimoto pricing](https://calimoto.com/en/pricing) · [Scenic Premium](https://scenic.app/premium/) · [Kurviger Tourer tiers](https://docs.kurviger.com/web/kurviger_tourer)
- [Komoot ChatGPT integration (2026)](https://biketips.com/komoot-chatgpt-ai-route-planning-integration-2026/) · [rides4you AI planner](https://rides4you.com/)
- [US motorcycle market — Grand View Research](https://www.grandviewresearch.com/industry-analysis/us-motorcycle-market) · [Registrations & demographics — ConsumerAffairs](https://www.consumeraffairs.com/insurance/motorcycle-industry-statistics-by-state.html) · [Touring segment data — Riders Share / MIC](https://www.riders-share.com/blog/article/touring-bikes-are-back-2026-mic-data)

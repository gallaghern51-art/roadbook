# tools/sims — verification harness

This repo has **no test suite or linter configured** (see `CLAUDE.md`). These scripts are the
coverage: Playwright sims that drive the real app at phone width with mocked routing/geocoding and
scripted GPS, plus one pure-node unit suite. They were written alongside the features they cover
and each one has caught at least one real bug.

## Running

```bash
npm run dev                        # must be up on :5199 first
node tools/sims/ride-nav-test.mjs  # pure node, no browser, no dev server needed
node tools/sims/ride-sim.mjs       # browser sims
```

Browser sims import `playwright-core` from `node_modules` and launch
`/opt/pw-browsers/chromium`. **`playwright-core` is not in `package.json`** — it is present in the
Claude Code sandbox image. On another machine, `npm i -D playwright-core` and point
`executablePath` at a local Chromium (or delete the option to use the bundled one).

Screenshots are written to `tools/sims/shots/` (gitignored).

Network is fully mocked — every sim aborts non-localhost requests and fulfils OSRM/Overpass/
Nominatim itself. That is deliberate: the dev sandbox's egress proxy blocks those hosts anyway,
and mocks make the sims deterministic.

## Status (verified Sept 6, 2026)

| script | result | covers |
|---|---|---|
| `ride-nav-test.mjs` | **34/34** | `rideNav.js` fact machine — every edge case in its module doc. Pure, fast, run this first. |
| `ride-sim.mjs` | **15/15** | Ride Mode SOP: speed calibration, leg readout, speed sign, skip/restore, mid-ride search, auto-skip → UNDO → arrival |
| `plans-check.mjs` | **20/20** | Plans strip: Current chip, drift dot, duplicate-trip fork, shared group/solo fork, `replace_trip` in the outbox, day-panel pill, proposal verbs |
| `spur-check.mjs` | **7/7** | Spur/projection-rewind cases, at-stop "Go next", masthead back button + contrast |
| `voice-zoom-sim.mjs` | **5/5** | Voice announcement tiers + speed-tiered camera zoom |
| `marker-gap-check.mjs` | **4/4** | Positional day-endpoint markers, day-boundary gap warning |
| `proposal-check.mjs` | **2/2** | Copilot proposal card fits mobile; "apply as new trip" forks cleanly |
| `head-font-check.mjs` | **5/6** | Masthead one-row + HUD type at 375/320px. The turn-card assertion never reaches a rendered card in this sim's scenario since the three-row bar restructure — **harness gap, not an app regression** (`.t-dist` is still 36px in `app.css`). |
| `pace-check.mjs` | **times out** | Group-pace setting. Drifted against the current Trip settings UI — needs its selectors refreshed. |
| `valhalla-check.mjs` | **10/10** | Valhalla owns planning, Ride Mode, and live reroutes; Google and OSRM routing fallbacks remain idle while it is healthy. |

Screenshot utilities with no assertions, not re-verified: `ui-sweep.mjs`, `light-ribbon.mjs`,
`light-late-sim.mjs`, `settings-shot.mjs`, `boot-check.mjs`.

`scenario-check.mjs` was deleted — superseded by `plans-check.mjs` (the day panel is a compact pill
now, not a chip strip).

## What `valhalla-check.mjs` guards

The sim independently counts Valhalla, OSRM planning, and OSRM navigation requests. Before Ride
Mode opens, it proves the plan was built by Valhalla with motorcycle costing, that intermediate
locations use `break_through`, and that OSRM planning did not engage. It then proves navigation and
manual retargeting use Valhalla without calling Google while the turn card renders Valhalla maneuver text. These are
observable behavior checks: a swallowed exception or accidental fallback fails the sim even when
the production build still compiles.

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

## Status against `main` @ 6cee7ea (verified Sept 6, 2026)

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
| `valhalla-check.mjs` | **2/6 on `main`, expected** | The Valhalla routing tier lives on **PR #49**, not on `main` — this sim only means anything on that branch, where it now passes **6/6**. See the note below; it is the most instructive script here. |

Screenshot utilities with no assertions, not re-verified: `ui-sweep.mjs`, `light-ribbon.mjs`,
`light-late-sim.mjs`, `settings-shot.mjs`, `boot-check.mjs`.

`scenario-check.mjs` was deleted — superseded by `plans-check.mjs` (the day panel is a compact pill
now, not a chip strip).

## What `valhalla-check.mjs` actually taught us

An earlier version of this README claimed this sim "would pass while testing nothing." **That was
wrong** and the correction is the useful part.

`main` renamed `attachLanes` → `attachRoadDetail`; the Valhalla tier on PR #49 still called the old
name, which is a `ReferenceError` swallowed by that tier's own `try/catch` — so it fell through to
OSRM on every route while the build stayed green. Run against that broken state, this sim fails
**4/6**, on `OSRM routing fallback never engaged`, because it asserts the fall-through never fires.
Against the fixed tier it passes 6/6.

So the harness was sound. It was simply never re-run after the rename. **That is a CI gap, not a
test-design gap** — the argument it makes is for wiring these sims into CI, not for distrusting
them. It is also the reason to prefer assertions about *observable behaviour* (did the fallback
engage? does the turn card render text?) over assertions about a fixture's shape: the behavioural
ones survive refactors of everything around them.

# AGENTS.md

**The architecture document for this repo is [`CLAUDE.md`](./CLAUDE.md) — read it before changing
anything.** It covers the op-based state model, the three-tier nav routing chain, Ride Mode
internals, trip sync, and a long list of field-caught bugs with the reasoning behind each fix.
Several of those fixes look like unnecessary complexity until you re-break them.

## Commands

```bash
npm run dev      # Vite dev server on port 5199
npm run build    # production build → dist/
```

## Things that will bite you

- **There is no test suite or linter configured.** Verify with `npm run build` plus exercising the
  UI. The engine modules in `src/engine/` are pure and easy to check in isolation — prefer adding a
  check there over hand-testing.
- **`npm run build` fails on any `t()` string missing from the Spanish dictionary** in
  `src/engine/settings.jsx`. Add the translation in the same commit as the new string.
- **Every trip mutation is an op.** New editing capability = a new op in `src/engine/ops.js`, wired
  into `describeOps`, and exposed in the planner tool schema so the AI can use it too. Do not mutate
  trip state directly.
- **Do NOT add `continue_straight=false` or `snapping=any` to OSRM requests.** Allowing U-turns at
  vias let the router touch a mid-pass stop and double back instead of riding through it —
  field-caught on Granite Pass. The road is the point.
- **Nav targeting lives only in `src/engine/rideNav.js`**, a pure fact machine (`visited` /
  `skipped` / `pinned`). The geometric projection is deliberately banned from targeting and is for
  display only — mixing it back in reintroduces a family of resurrection bugs. Read that module's
  header comment; it enumerates the edge cases and why each exists.
- **Pushing to `main` deploys to production** via Netlify. Branch and open a PR.

## Verification

There is no `npm test`. The coverage lives in **`tools/sims/`** — Playwright sims that drive the
real app at phone width with mocked routing and scripted GPS, plus a pure-node unit suite for the
nav engine. Read `tools/sims/README.md` for how to run them and which currently pass. Start with:

```bash
node tools/sims/ride-nav-test.mjs   # 34 unit tests, no browser needed
```

If you change Ride Mode, run `ride-sim.mjs` and `spur-check.mjs` before shipping.

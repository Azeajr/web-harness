# web-harness roadmap

Open, not-yet-built work for web-harness itself. Shipped work lives in git history and
`docs/HARNESS.md`, not here: when an item ships, delete it from this file and update the guide.

**Basis.** Written 2026-09-27 from an audit of `ee70460` (v0.1.4) against
`~/github/harness-design-review.md` (the design this harness implements) and against what the four
consumers (chess-mcp, chorequest, tabletop-strategy-companion, training-log) showed during
adoption. Every "Today" line below was checked in the source at that commit; file:line references
are to that commit. Anything not verified is marked **open question**.

**Scope.** Only work that belongs in this repository: the controller, the Playwright exports, the
smoke, the container runner, the scenario inventory, the composite actions, the docs, and anything
consumers would otherwise each re-implement. Consumer-only follow-ups are listed in Appendix A so
they are not lost, but they are not web-harness work.

**Sizes.** S = one module plus unit tests. M = a new command or helper touching several modules,
plus unit tests. L = a new subsystem that needs the Docker acceptance suite (G1) to prove it.

---

## Contents

| ID | Item | Size | Milestone |
|---|---|---|---|
| [A5](#a5-record-a-batch-from-cli-actions) | Record a batch from CLI actions (optional) | S | M4 follow-up |

## Milestones

The order is deliberate. Each milestone is one minor release; consumers bump the dependency and
every `uses:` reference together (README, "Released by tag").

- **M0 — Foundation** shipped: the memory budget (H1), the acceptance suite against
  `examples/minimal` in CI (G1), and housekeeping. Later items are proven by extending that suite.
- **M1 — Agent evidence** shipped: failure bundles (E1), `effect` (E2), attempts and flaky
  scenarios (E3), batch-local fault expectations (E4) and the shared Playwright preset (A1).
- **M2 — Offline-first proof** shipped: the smoke's update phase (O1), the online phase and
  header value rules (O2).
- **M3 — Determinism and provenance** shipped: clock, timezone and locale (P1), run manifest v3
  (P2), one status vocabulary (P3), scenario reports tied to source and build (P4), reconcile after
  an unknown outcome (P5), redaction (P6) and the host server's isolated environment (H2).
- **M4 — Agent ergonomics** shipped: the agent skill with `describe` and `skill install` (A2),
  `promote` with `applyHarnessFixture` and `batchHelpers` (A3), and the accessibility scan (A4).
  One optional follow-up remains (A5).
- **M5 — Extended tier and measurement** shipped: the reusable scheduled workflow with
  `mutation-score` (G2), and phase timings, peak memory and `bench` (H3). Proving G2 on a real
  schedule is consumer work (Appendix A).

---

## M4 follow-up

### A5. Record a batch from CLI actions

**Why.** An agent that explores command by command (`cli click e12`, `cli fill e7 …`) has no batch
file to `promote`. The Playwright CLI (1.63) has `recording-start` and `recording-stop`.

**Today.** Not built. `promote` needs a batch file written by hand.

**Design.** `web-harness record start|stop [--to batches/NAME.js]` wraps the CLI's recording in the
owned session and turns what it produced into a batch function (`async (page, { step }) => …`), one
`step` per recorded action. Verify first what `recording-stop` emits in 1.63 (script text, a JSON
action log, or a trace); if it is not stable enough to transform, drop this item.

**Acceptance.** Recording a save in `examples/minimal`, then `promote`, gives a spec that passes
under `web-harness e2e`.

---

## Appendix A — Consumer follow-ups (not web-harness work)

Kept here so they are not lost. Each happens in the consumer's own repository, through a PR.

- **Version bumps.** v0.2.0 carries M0–M5. training-log and tabletop are on v0.1.2; chess-mcp is
  on v0.1.3; chorequest on v0.1.4. Bump each to v0.2.0, in the dependency and in every `uses:`,
  together. Breaking for a running session only: a schema 2 session must be stopped with the old
  version first. The smoke gains an `a11y` phase only where an `a11y` block is configured.
- **chess-mcp E2E evidence.** Its Playwright config has no retries, trace, screenshot or video.
  Adopting A1 fixes it; until then, add them directly.
- **Skills.** Run `web-harness skill install` in training-log, tabletop and chorequest. chess-mcp
  links its `ux-review` skill to the shared one.
- **Accessibility.** Add `axe-core` and an `a11y` block to opt into `check --a11y`, `checkA11y` and
  the smoke's `a11y` phase; start with `impact: 'critical'` and tighten.
- **Promote.** Set `e2e.fixtures` where the fixtures module is not `tests/e2e/fixtures.ts`.
- **Update-flow hooks.** Each consumer adds `smoke.update.prompt`/`accept` for its own prompt (O1).
- **Extended tier.** training-log adopts `extended.yml` nightly with `mutation: true` and a
  threshold (it needs Stryker's `json` reporter), and checks that a threshold above its score
  opens the issue and the next green run closes it — the proof G2 still needs. chorequest (private,
  2,000 free minutes) runs it weekly after measuring one run.
- **Baselines.** Run `web-harness bench` in each consumer on the machines that matter and record
  the numbers before setting any budget.
- **Environment.** chorequest moves its clock pin from `apply` into `environment` (P1).
  training-log should decide its timezone variants (sessions and cycles are date-driven).
- **chorequest branch protection.** Unavailable: a private repository on the free plan. The
  workflow's `deploy` `needs: [checks, smoke]` is the only gate. Nothing to do unless the plan
  changes.

## Appendix B — Out of scope

The design review names these, and they stay out of web-harness on purpose:

- **TUI and peer-process labs (herdr) and multi-service adapters (firecrawl).** web-harness is for
  offline-first Vite PWAs. Those domains keep their own harnesses. What transfers is the evidence
  model: E1, E2 and P2 borrow it.
- **Live providers and real devices.** Installed-PWA behaviour on iOS, locked-phone timers and OS
  notification delivery stay `unsupported` scenarios with a reason. They are never represented as
  deterministic coverage.
- **From the review's closing warning:** "Do not begin by building a universal daemon, MCP server,
  dashboard, new DSL or massive browser matrix." Every item above extends an existing command or
  export.

## Appendix C — Already built (do not rebuild)

For orientation, and so that nobody re-implements these:

| Capability | Where |
|---|---|
| `doctor`/`preflight`: Docker, pinned image, probe launch, port | `src/controller.mjs:387-463` |
| `start --target dev\|production`, production build digest in the session directory | `src/controller.mjs:465-493, 880-961` |
| `run` batches: step history, stop at first failure, retained faults fail a batch, capture errors never replace the original | `src/batch.mjs`, `src/controller.mjs:267-335` |
| `observe` (bounded geometry, clipping, focus); `state` (dev accessor, `unsupported` on production) | `src/inspect.mjs` |
| `reload` / `restart` (same profile, faults retained) / `reset` (digest-checked) as distinct operations | `src/controller.mjs:756-790, 1030-1046` |
| Ownership: port leases, process identity, container labels, identity token; foreign or replaced servers refused; cleanup failure is a harness failure | `src/core.mjs`, `src/controller.mjs:155-208, 792-841` |
| One fault policy for the controller, the Playwright fixture and the smoke; `allowPageFaults`/`expectPageFault` in tests | `src/faults.mjs`, `src/browser.mjs`, `src/watch.mjs`, `src/playwright.mjs` |
| Layout overflow of overlays; full-page captures name internally scrolled panes | `src/browser.mjs:105-175` |
| Pages-style static server: `_headers`, SPA fallback, unserved prefixes; never reuses a running server | `src/static-server.mjs`, `src/playwright.mjs:74-106` |
| Production smoke: headers, bundle, globals, SW control, persistence, offline | `src/smoke.mjs` |
| Container E2E: pinned image, bounded, canonical pixel baselines, prebuilt artifact, rehomed results | `src/container.mjs` |
| Scenario inventory with test, lane, `unsupported` and `not-run` | `src/scenarios.mjs` |
| Mutation testing in a throwaway copy | `src/mutate.mjs` |
| `scope` (prose skip-list; an unknown file counts as code), `setup`, and `verdict` (always reports; a skipped required job fails it) | `.github/actions/*` |

## Appendix D — Traceability to the design review

| Review section | Requirement | Status / item |
|---|---|---|
| A | `doctor` | built, with the memory budget |
| A | `start --target` | built |
| A | `run` with step history | built, with attempts |
| A | `observe`, `state` | built |
| A | `effect` | built (batch helper and command) |
| A | `check` | built, with `--a11y` |
| A | reload / restart / reset / stop | built |
| A | `report` for the exact source/build, keeping failed attempts | built (attempts; `scenarios --lane`, `--build-digest`) |
| A | isolate HOME/XDG | built (browser and host server) |
| A | cleanup failure is a harness failure | built |
| B | two targets, dev accessors read-only, production digest, same artifact validated and deployed | built |
| C | versioned manifest with the listed fields | built (schema 3, `schemas/run-manifest.v3.json`) |
| C | status vocabulary | built (`src/status.mjs`) |
| C | run directory with steps, faults, state, events, screenshots, optional trace | built (failure bundles) |
| C | redaction | built (query values, no headers or bodies; traces flagged) |
| C | retries as attempts | built |
| C | reconcile before replaying after an unknown outcome | built (`reconcile`, `--after-unknown`) |
| D | named fixtures through real import paths | built (adapter `fixtures`; in tests, `applyHarnessFixture`) |
| D | clock / locale / timezone, DST variants | built (`environment`, batch `clock`; `extended.yml` `timezones`) |
| D | one fault policy; expected faults local, counted, missing ones fail | built, in tests and batches |
| D | infrastructure vs application failure by source | built (`infrastructure_failed` by source) |
| E | production tier: SW update flows | built (smoke `update` phase) |
| E | production tier: offline/reconnect, security headers | built (`offline`, `online`, header value rules) |
| E | extended tier on a schedule | built (`.github/workflows/extended.yml`); adoption in Appendix A |
| E | always-reporting aggregate verdict; deploy consumes the validated artifact | built |
| E | fail on focused-only tests | built (`harnessPlaywright`) |
| E | mutation in isolation | built, scheduled by `extended.yml` with a score threshold |
| F | warm session, batching, narrow state, build once | built |
| F | measure equivalent scenarios | built (manifest `timings`/`metrics`, `bench`) |
| F | bound container and host separately | built, with the memory budget |
| Delivery 1 | controller acceptance in CI | built (`test/acceptance`, required in CI) |
| Delivery 2 | production restart journey | built; automated in `test/acceptance` |
| Delivery 3 | scenario inventory and aggregate gate | built, tied to revision and build |
| Delivery 4 | failure bundles explain a real induced defect | built; proven in `test/acceptance` |

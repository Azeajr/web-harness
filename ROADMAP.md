# web-harness roadmap

Open, not-yet-built work for web-harness itself. Shipped work lives in git history and
`docs/HARNESS.md`, not here: when an item ships, delete it from this file and update the guide.

**Basis.** Written 2026-09-27 from an audit of `ee70460` (v0.1.4) against
`~/github/harness-design-review.md` (the design this harness implements) and against what the four
consumers (chess-mcp, chorequest, tabletop-strategy-companion, training-log) showed during
adoption. Every "Today" line below was checked in the source at that commit; file:line references
are to that commit. Anything not verified is marked **open question**.

**Updated 2026-09-28** after v0.2.1 and moving all four consumers to v0.2.0: M0–M5 are shipped. What
remains is three small gaps found during that move (O3, H5, A6), one optional item (A5), and the
consumer follow-ups in Appendix A, ordered by value.

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
| [O3](#o3-the-smoke-finds-the-service-worker-itself) | The smoke finds the service worker itself | S | v0.2.2 |
| [H5](#h5-a-stale-port-lease-says-how-to-clear-it) | A stale port lease says how to clear it | S | v0.2.2 |
| [A6](#a6-skill-commands-for-npm-projects) | Skill commands for npm projects | S | v0.2.2 |
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
- **v0.1 → v0.2 follow-ups** shipped in v0.2.1: a `--` right after a tool command is dropped
  (`pnpm <script> -- --shard=…` had made every chess shard run the whole suite).
- **v0.2.2 — gaps found moving the consumers.** O3, H5, A6: each small, each hit for real.

---

## v0.2.2 — gaps found moving the consumers

### O3. The smoke finds the service worker itself

**Why.** The update phase publishes a second version by changing the worker script's bytes, so it
must know which file that is. training-log's worker is `service-worker.js` (vite-plugin-pwa
`injectManifest` with `filename`), and its first v0.2.0 smoke failed: "No sw.js in the build; set
smoke.update.sw, or smoke.update: false." It needed a config line (training-log #189).

**Today.** `src/smoke.mjs` defaults `smoke.update.sw` to `"sw.js"`.

**Design.** By the update phase the page is controlled (the `sw` phase proved it), so read
`navigator.serviceWorker.controller.scriptURL` and use its path when `smoke.update.sw` is not set.
`sw` stays as an override. The update check's detail names the file it republished.

**Acceptance.** A variant of `examples/minimal` whose worker is renamed passes the update phase with
no `sw` setting. training-log can then drop its `update.sw` line.

### H5. A stale port lease says how to clear it

**Why.** A session killed hard (SIGKILL, a crash) leaves `/tmp/web-harness-<uid>-port-<N>.lock`.
Every later start on that port is then refused with "Review port is reserved … Stop its recorded
owner first", even when the recorded owner's directory is gone. This happened on 2026-09-27 after a
force-killed acceptance run, and the file had to be found and removed by hand.

**Today.** `acquirePortLease` (`src/core.mjs`) refuses any existing lease. The lease records the
token, root, project, session and `manifestPath`, but no process.

**Design.**
- A lease is stale when its `manifestPath` does not exist and nothing listens on the port.
- `doctor` names stale leases. `start` refuses with the exact command to remove one, or reclaims
  it under `--reclaim-stale-lease`.
- A lease whose manifest exists is never touched: a live or stopped-but-owned session still owns it.

**Open question.** `start` writes the lease before the manifest. Record the starting process's
identity in the lease and require it dead too, so a session that is mid-start never looks stale.

**Acceptance.** After a SIGKILL-ed start whose session directory was removed, `doctor` names the
lease and `start --reclaim-stale-lease` succeeds; with the manifest present, it still refuses.

### A6. Skill commands for npm projects

**Why.** The shipped skill tells an agent to run `pnpm exec web-harness describe --json` and
`pnpm exec web-harness doctor`. tabletop is an npm project (`npx web-harness`,
`npm run harness -- …`).

**Design.** Name both forms once ("`pnpm exec web-harness` — or `npx web-harness` in an npm
project") and use plain `web-harness …` elsewhere, as the rest of the skill already does. Consumers
reinstall the skill with their next bump.

**Acceptance.** The skill test still passes. tabletop's installed copy names `npx`.

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

Kept here so they are not lost. Each happens in the consumer's own repository, through a PR. In
the order they pay off. Checked 2026-09-28 unless noted.

1. **Use the shared Playwright settings (A1) — all four.** None of the four spreads
   `harnessPlaywright(harness)` into its Playwright config. chess-mcp's config has no retries,
   trace, screenshot or video, so a failing E2E test in CI leaves no evidence to read. The preset
   adds the failing attempt's trace, a screenshot and video, `forbidOnly`, one retry in CI and
   `failOnFlakyTests`. Keep project settings as overrides.
2. **Finish the update check in the smoke (O1) — all four.** Each smoke's update phase reports
   `activation: "not exercised"`: it proves a new version is detected and waits for consent, but
   never accepts it. Add `smoke.update.prompt` (wait for the app's own update prompt) and `accept`
   (click it), and `dismiss` where the app has one. The smoke then proves the new version
   activates, keeps the data and reloads once.
3. **chorequest: move the pinned clock into `environment` (P1).** Its fixture pins time with
   `page.clock.setFixedTime` inside `apply` (`harness.config.mjs:19`), which a `restart` loses.
   `environment: { clock: 'fixed', now }` is re-applied on every open and also reaches the
   Playwright suite.
4. **Accessibility (A4) — opt-in, all four.** Add `axe-core` and an `a11y` block to turn on
   `check --a11y`, the `checkA11y` fixture and the smoke's `a11y` phase. Start with
   `impact: 'critical'` and tighten; expect real findings on the first run.
5. **Extended tier (G2) — training-log first.** Adopt `extended.yml` nightly with `mutation: true`
   and a threshold (Stryker needs its `json` reporter). Check that a threshold above the current
   score opens the issue and the next green run closes it; that is the proof G2 still needs.
   chorequest (private, 2,000 free minutes a month) runs it weekly, after measuring one run.
6. **Timezone variants — training-log.** Sessions and cycles are date-driven: decide which zones and
   DST dates to run (`extended.yml` `timezones`, or `e2e --timezone`), e.g. America/New_York across
   2026-03-08 and 2026-11-01, and Pacific/Kiritimati.
7. **chess-mcp: a flaky focus test.** `apps/ui/test/e2e/strategic-fit-stage-layout.spec.ts:97`
   (WP-033 AC-4, chromium) failed `toBeFocused` once in CI on #82. It passed 20 of 20 locally and in
   the other five CI runs. Watch it; #1 above keeps the evidence next time.
8. **Version bumps.** All four moved to v0.2.0 on 2026-09-28 (training-log #189, tabletop #26,
   chess-mcp #82, chorequest #11). v0.2.1 only drops a `--` after a tool command, which chess
   already fixed in its CI (#83), so take it, or v0.2.2, with the next dependency update. With
   every bump:
   - reinstall the agent skill (`doctor` warns when it is stale);
   - with pnpm 11, check that the lockfile entry for `@azeajr/web-harness` still has an
     `integrity`. pnpm 11 omits it when the tarball is already in the local store; resolve with
     `pnpm install --lockfile-only --store-dir <empty dir>` (11.3 also needs `node_modules` moved
     aside).
9. **Baselines.** Run `web-harness bench` in each consumer on the machines that matter and record
   the numbers before setting any budget.
10. **Promote.** Set `e2e.fixtures` where the fixtures module is not `tests/e2e/fixtures.ts`.
11. **Repository setting — all five, including this one (decision pending).** GitHub's
    "Automatically delete head branches" removes a PR's branch when it merges. Until now merged
    branches were deleted by hand. It changes nothing else.
12. **chorequest branch protection.** Unavailable: a private repository on the free plan. The
    workflow's `deploy` `needs: [checks, smoke]` is the only gate. Nothing to do unless the plan
    changes.

Done, for the record: the agent skill is installed in all four (training-log #190, tabletop #27,
chess-mcp #84, chorequest #12). chess keeps it in `.agents/skills/`, because its `.claude/skills/`
holds the plugin's product skills.

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

For orientation, and so that nobody re-implements these. The table is v0.1.4 (line numbers are from
`ee70460`); everything M0–M5 added is described in `docs/HARNESS.md`.

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

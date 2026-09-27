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
| [H1](#h1-memory-budget-before-any-heavy-run) | Memory budget before any heavy run | S | M0 |
| [G1](#g1-controller-acceptance-in-ci) | Controller acceptance suite in CI | L | M0 |
| [K1–K5](#housekeeping) | Housekeeping | S | M0 |
| [E1](#e1-failure-bundles) | Failure bundles: trace, network, console, storage, DOM | L | M1 |
| [E2](#e2-effect-before-and-after-around-one-action) | `effect`: before/after around one action | M | M1 |
| [E3](#e3-retries-are-attempts-flaky-is-not-verified) | Retries are attempts; flaky is not verified | S | M1 |
| [E4](#e4-expected-and-allowed-faults-inside-batches) | Expected and allowed faults inside batches | S | M1 |
| [A1](#a1-shared-playwright-preset) | Shared Playwright preset | S | M1 |
| [O1](#o1-update-flow-in-the-production-smoke) | Update flow in the production smoke | M | M2 |
| [O2](#o2-smoke-back-online-and-header-values) | Smoke: back online, and header values | S | M2 |
| [P1](#p1-clock-timezone-and-locale) | Clock, timezone and locale | M | M3 |
| [P2](#p2-run-manifest-v3) | Run manifest v3 | M | M3 |
| [P3](#p3-one-status-vocabulary) | One status vocabulary | S | M3 |
| [P4](#p4-scenario-report-tied-to-revision-and-build) | Scenario report tied to revision and build | S | M3 |
| [P5](#p5-reconcile-after-an-unknown-outcome) | Reconcile after an unknown outcome | S | M3 |
| [P6](#p6-redaction) | Redaction | S | M3 |
| [H2](#h2-isolate-the-host-servers-environment) | Isolate the host server's environment | S | M3 |
| [A2](#a2-agent-skill-shipped-with-the-package) | Agent skill shipped with the package | S | M4 |
| [A3](#a3-promote-a-batch-into-a-test) | Promote a batch into a test | M | M4 |
| [A4](#a4-accessibility-scan) | Accessibility scan | M | M4 |
| [G2](#g2-reusable-extended-workflow) | Reusable extended workflow (scheduled) | M | M5 |
| [H3](#h3-measure-the-harness-itself) | Measure the harness itself | M | M5 |

## Milestones

The order is deliberate. Each milestone is one minor release; consumers bump the dependency and
every `uses:` reference together (README, "Released by tag").

- **M0 — Foundation.** H1 first: the only item here that prevents harm (a stacked container run
  hard-crashed a 12 GB, no-swap host on 2026-09-27). Then G1, because almost every later item
  changes controller paths that today are proven only by unit tests with mocks; after G1 each of
  those changes is proven against a real container in CI. Housekeeping rides along.
- **M1 — Agent evidence.** The core purpose: an agent exercises a workflow and keeps enough
  evidence to explain a failure without re-running it. E1 and E2 are the substance; E3 and E4 stop
  the evidence from lying (a hidden flaky failure, a correct error path reported as a failure). A1
  gives the Playwright suites the same evidence.
- **M2 — Offline-first proof.** O1 closes the one common PWA failure nothing checks today: a new
  deploy that never reaches, or breaks, an installed client.
- **M3 — Determinism and provenance.** Make every run reproducible and attributable: environment
  pinned, manifest complete, one status vocabulary, scenario results tied to the build, no blind
  replays, nothing sensitive in evidence, the host server isolated.
- **M4 — Agent ergonomics.** Ship the skill, close the promote-to-test step, add accessibility.
- **M5 — Extended tier and measurement.** Scheduled coverage and harness performance baselines.

---

## M0 — Foundation

### H1. Memory budget before any heavy run

**Why.** On 2026-09-27 a background `web-harness e2e` (Docker, `--memory 6g`) plus a native
four-worker Playwright run hard-crashed and rebooted a 12 GB host with **0 B swap**. With no swap,
memory pressure locks the machine instead of OOM-killing one process. Nothing in the harness looks
at headroom before starting a container.

**Today.**
- `preflight`/`doctor` checks the platform, Docker, the pinned image, a probe browser launch, and
  the port (`src/controller.mjs:387-463`). No memory check.
- Container E2E defaults to 6 GB and `min(4, cores)` CPUs (`src/container.mjs:80-83`).
- A session's container defaults to 3 GB, `min(2, cores)` CPUs, and the host server gets a 1 GB V8
  heap (`src/controller.mjs:67-72`). esbuild and other server children are unbounded (comment at
  `src/controller.mjs:63-66`).
- Nothing counts other running harness containers.

**Design.**
- `resourceBudget()` in `src/core.mjs`:
  - read `/proc/meminfo` (`MemAvailable`, `SwapTotal`, `SwapFree`);
  - list running containers labelled `web-harness.root` (sessions) or named `wh-e2e-*` (E2E) and
    sum their `HostConfig.Memory` from `docker inspect`;
  - return `{ available, swap, harnessContainers: [{ name, memory }], need, ok }`.
- `need` = the container's memory bound + the server heap (sessions only) + a margin. The margin
  defaults to 1.5 GB, or 2.5 GB when swap is 0, and `WEB_HARNESS_MEMORY_MARGIN` overrides it.
- `start` and `e2e` refuse when `MemAvailable < need`. The message names every running harness
  container with its bound and the command that stops it (`web-harness stop --session X`). The
  override is `--force-resources`; it is recorded in the manifest and printed on every command.
- `e2e` memory is `auto` by default: `min(6g, MemAvailable − margin)` with a 3 GB floor; below the
  floor it refuses. An explicit `WEB_HARNESS_E2E_MEMORY` still wins.
- With 0 swap, `doctor` prints a table (available, swap, running harness containers, what `start`
  and `e2e` would need) and one warning line: "no swap: memory pressure freezes the host instead of
  killing one process".
- The effective limits go into the manifest (see P2 `limits`).

**Acceptance.**
- Unit tests over injected meminfo text and container lists: sufficient, insufficient, no swap,
  an already-running E2E container.
- A second `web-harness e2e` started while one runs on a host without room is refused before any
  `docker run`.
- `--force-resources` proceeds and says so in its output.

**Open question.** Whether to count known heavy non-harness processes (browsers, other
containers). Start with harness containers only; other load is already reflected in `MemAvailable`.

### G1. Controller acceptance in CI

**Why.** Delivery step 1 in the design review: "Add focused controller acceptance to appropriate
CI changes. Acceptance: deliberate assertion/network faults produce a nonzero verdict and retained
original error; cleanup cannot affect a foreign session; server/worktree replacement is rejected."
The review also lists "Controller Docker acceptance is opt-in" as a gap. It still is.

**Today.**
- web-harness CI runs `pnpm check` (syntax plus unit tests, one of which drives a real Chromium)
  (`.github/workflows/ci.yml:26`, `package.json` `check`).
- `package.json` has `"test:docker": "node --test test/docker/*.test.mjs"`, but `test/docker/`
  does not exist (see K1).
- `examples/` is an empty local directory (see K2).
- chess-mcp's `scripts/harness.integration.test.mjs` drives the real controller against the chess
  app, but it is opt-in and local: "Docker, not in CI" (`chess-mcp/docs/PROJECT_STATE.md:31`).
- Result: `start`, `run`, `restart`, `reset` and `stop` against a real container, and the ownership
  refusals, have no automated proof in any CI.

**Design.**
- `examples/minimal/`: the smallest app that exercises every adapter hook.
  - Vite with no framework: `index.html` and `main.js`.
  - A save button that writes to localStorage and IndexedDB.
  - A service worker (vite-plugin-pwa, `registerType: 'prompt'`, like every consumer), so the smoke
    and O1 have something real to test.
  - A route that calls `console.error` on demand (for induced faults), and a `fetch('/api/x')` for
    `unservedPrefixes`.
  - `public/_headers` with a CSP.
  - A dev-only state accessor (`window.__harness`).
  - `harness.config.mjs` with two fixtures (one through a file input, like chorequest), `state`,
    `production`, `smoke` hooks and three scenarios: one test, one lane, one `unsupported`.
  - A two-test Playwright suite using `createHarnessTest`.
  - Its own `package.json` and lockfile, not a workspace member, so `web-harness e2e` exercises a
    real install.
- `test/docker/controller.test.mjs`, each case with an explicit timeout and a `finally` that stops
  the session:
  1. `preflight` passes and prints the image ID.
  2. `start` (dev): a manifest with identity, `00-seeded.yml`, the seeded screenshot, zero faults.
  3. `run` of a passing batch using `step`, `assert`, `observe`, `state`: `ok: true`, steps timed.
  4. `run` of a batch that triggers `console.error`: exit 1, the original error retained, a
     screenshot and state captured, `faults.json` written.
  5. `restart`: the saved value is still there, and faults from before the restart are retained.
  6. `reset`: a new run directory, the fixture replayed, the saved value gone.
  7. `reset` after editing the fixture's `apply`: refused ("Fixture/setup changed").
  8. A second `start` on the same port from another session: refused by the lease.
  9. A foreign server on the port (a plain `http.createServer`): refused, and never signalled.
  10. `start --target production`: build digest recorded, `state` answers `unsupported`, no dev
      identity meta tag.
  11. `stop`: afterwards `docker ps -a --filter label=web-harness.root=<root>` is empty, the lease
      file under `/tmp` is gone, and the server PID no longer exists.
  12. An interrupted `start` (SIGINT after the container is created): cleanup runs and nothing is
      left.
- `test/docker/smoke.test.mjs`: the smoke passes on the example. Each broken variant fails in the
  right phase: a missing header (`headers`), a leaked `__harness` (`globals`), a service worker
  that never installs (`sw`), an unprecached `index.html` (`offline`).
- `test/docker/e2e.test.mjs`: container E2E on the example, with results rehomed and `scenarios
  --results` reporting `verified`.
- CI: a `docker` job on `ubuntu-latest` (a public repository gets 4 cores and 16 GB, and Docker is
  preinstalled). Cache the pinned image by tag. The job is required in `verdict` whenever `src/`,
  `bin/`, `test/docker/` or `examples/` change (a `scope` output for those paths).

**Acceptance.**
- The job is green on `main`.
- Verified by reverting guards (a test that has never failed proves nothing): make
  `ownsContainer` return `true` and case 9 or 11 fails; drop the retained-faults concat in `check`
  (`src/controller.mjs:635-641`) and case 5 fails; remove the digest refusal in `reset`
  (`src/controller.mjs:1031-1035`) and case 7 fails.
- Record the job's wall time. **Open question:** the estimate is 5–8 minutes, mostly the image
  pull.

### Housekeeping

- **K1.** `package.json` `test:docker` points at `test/docker/`, which does not exist. Create it
  with G1, or remove the script until then.
- **K2.** `examples/` is an empty directory in the local checkout (git does not track empty
  directories). It becomes `examples/minimal/` with G1.
- **K3.** `docs/HARNESS.md:5-8` names "keep a failure bundle" as a step of the loop. Today a
  failure keeps a screenshot, a state read and `faults.json`, not a bundle. Qualify the sentence now
  and restore it when E1 ships.
- **K4.** Release checklist in the README: tag; update the `#vX` in the README install line and the
  `@vX` in its `uses:` lines; list consumers that need the bump.
- **K5.** Version drift check. Consumers must pin the same tag in the dependency and in every
  `uses:` reference (README, "Released by tag"). As of 2026-09-27 they sit on different tags
  (training-log and tabletop v0.1.2, chess-mcp v0.1.3, chorequest v0.1.4). `doctor` should read the
  installed package version and grep `.github/workflows/*.yml` for
  `Azeajr/web-harness/.github/actions/*@v…`, and warn on any mismatch.

---

## M1 — Agent evidence

### E1. Failure bundles

**Why.**
- The loop in `docs/HARNESS.md:5-8` includes "keep a failure bundle".
- The design review (section C): "Full evidence goes to a run directory: manifest, steps, faults,
  state snapshots, command/events log, screenshots on failure or requested visual states, optional
  trace started before reproduction."
- From herdr: "Failure evidence is a directory containing states, screens, logs, merged timeline
  and command history — not just a screenshot."

The purpose is that an agent, or a person later, can explain a failure from the bundle alone,
without replaying it.

**Today.**
- A failed batch captures a PNG and one state read into flat files beside the batch
  (`src/batch.mjs:40-48`), and the controller then writes `faults.json` (`src/controller.mjs:292-298`).
- Nothing records the request log or console log:
  - The Playwright CLI's own logs are cleared right after seeding (`src/controller.mjs:732-733`).
  - Those logs are scoped to a navigation (`src/browser.mjs:7-8`).
  - The policy records only failures: failed requests, HTTP ≥ 400, external calls, error console
    lines (`src/browser.mjs:21-45`). A successful request sequence, which is often what explains a
    wrong result, is never kept.
- Not captured at failure: an accessibility-tree snapshot, storage and service-worker state, or a
  trace.
- A failure in `start` or `check` keeps even less than a failed batch.

**Design.**
- **Directory per batch.** `<runDir>/batch-<id>/` holds `source.js`, `wrapped.js` and
  `report.json`, plus `bundle/` on failure. This replaces today's flat `batch-<id>.*` files; the
  stdout JSON keeps the same keys and adds `bundle`.
- **Request ring on the context**, next to `__webHarnessFaults`:
  - `installPolicy` (`src/browser.mjs:9`) and `watchContext` (`src/watch.mjs:15`) both keep
    `__webHarnessRequests`.
  - Recorded from `request`, `requestfinished`, `requestfailed` and `response`.
  - Entry: `{ seq, at, method, url, resourceType, status, fromServiceWorker, failure, ms }`. URLs
    pass through P6 redaction.
  - No bodies, and no headers unless allowlisted (P6).
  - Capped at 2,000 entries; overflow is counted in `dropped`, never silently lost.
  - Because it is on the context, it survives reloads, unlike the CLI's navigation-scoped log.
- **Console ring:** every console message at every level, `{ seq, at, type, text (≤ 500 chars),
  location }`, capped at 1,000. Today only error-level and watched lines survive, as faults or
  warnings.
- **Batch markers.** At batch start the wrapper records the current `seq` of each ring, so the
  bundle can show "during this batch" plus the 50 entries before it for context.
- **On failure, `bundle/` contains:**
  - `screenshot.png` (as today), `state.json` (as today; `unsupported` on production).
  - `aria.yml`: `page.locator('body').ariaSnapshot()` (available in Playwright 1.63), a bounded,
    text-first view of what the user could see and reach.
  - `network.jsonl` and `console.jsonl`: the slices described above.
  - `faults.json`: every record, with a flag for which ones count as faults.
  - `storage.json`: `navigator.storage.estimate()`, localStorage keys only (never values),
    `indexedDB.databases()` names and versions, `caches.keys()`, the service-worker registration
    (the active, waiting and installing script URLs and states, and whether a controller is
    present), plus the URL and viewport. For offline-first apps this is usually where the answer
    is.
  - `timeline.jsonl`: `events.jsonl` (controller), steps (start and end), faults, console lines and
    requests merged by timestamp, each tagged `{ runId, batchId, attempt, source }`. This is the one
    file to read top to bottom. Captures are sequential and it must say so: a screenshot and an
    asynchronous state read are not atomic (design review, section C).
  - `index.json`: each file with its byte size, truncation or `dropped` counts, and any capture
    error. A failed capture never replaces the original error (existing rule, `artifactErrors` at
    `src/batch.mjs:20,42-47`).
- **Trace.**
  - `run FILE --trace` (and `start --trace` for the whole session) starts
    `context.tracing.start({ screenshots: true, snapshots: true })` before the batch.
  - On failure it stops into `bundle/trace.zip`. On success the trace is discarded, unless
    `--trace=keep`.
  - Default off, as the review says: an "optional trace started before reproduction". Config key
    `evidence.trace` changes the default.
  - Traces include request and response bodies and headers (Playwright CLI tracing reference), so
    `index.json` flags `trace.zip` as possibly containing private data (P6).
- **Summary on stdout.** The batch JSON stays under the 16 KB limit (`src/controller.mjs:320-333`),
  and on failure adds `summary`: the first fault, the last three failed or ≥ 400 requests, the last
  error-level console line, the final URL, the waiting service worker if any, and the bundle path.
  The agent gets the gist in one read and opens files only when needed.
- **Other failures.** `start` (after the container exists), `check` and `restart` failures write a
  bundle too, under `<runDir>/failure-<n>/`.
- **Playwright parity.** `createHarnessTest` (`src/playwright.mjs:16`) attaches `network.jsonl`
  and `console.jsonl` to `testInfo` when a test fails, so E2E failures carry the same evidence.
  A1 covers the trace.

**Acceptance.**
- Against `examples/minimal`, a batch that calls an endpoint answering 500 and then fails an
  assertion produces a bundle in which:
  - `network.jsonl` contains the 500 and the successful requests before it;
  - `console.jsonl` contains the page's log lines;
  - `aria.yml`, `storage.json` (listing the IndexedDB database and the SW registration) and
    `timeline.jsonl` exist, and the timeline is in order;
  - with `--trace`, `trace.zip` opens with `npx playwright show-trace`.
- A passing batch writes no `bundle/` and, without `keep`, no trace.
- Ring caps are enforced and reported in `index.json`.
- Stdout stays ≤ 16 KB and contains `summary.bundle`.
- A failing E2E test on the example has `network.jsonl` and `console.jsonl` attachments.

**Tests.** Unit tests for the ring buffer (cap, `dropped`, slicing by `seq`) and the timeline merge
(pure functions); Docker acceptance in G1.

**Open questions.**
- Whether `context.tracing` started inside `run-code` coexists with the CLI's own
  `tracing-start`/`tracing-stop` (Playwright CLI 1.63 has both). Only one trace can run per
  context, so the controller should own tracing and add `tracing-start`/`tracing-stop` to the
  refused `cli` subcommands (`src/controller.mjs:1058-1068`).
- Whether traces on a persistent-profile context behave the same across `restart`. Expected: the
  trace ends with the closed browser.

### E2. `effect`: before and after around one action

**Why.**
- The design review's command list includes `effect` beside `observe` and `state`.
- From herdr: `effect` "compares state across instances and client screens around a real input
  event. This catches a button acting on the wrong peer even when the API works."
- Section D: "'No exception,' 'button clicked,' and 'screenshot written' are insufficient."

The commonest agent mistake this catches is a click that silently did nothing, or changed
something other than what was intended.

**Today.** There is no before/after primitive. Agents hand-roll `observe`/`state` calls around an
action in a batch, inconsistently, and a no-op usually passes.

**Design.**
- **Batch helper:** `effect(name, action, watch)`, where `watch` is:
  ```js
  {
    observe: ['.move-tree', '[role=dialog]'],   // selectors, read with observe() (bounded)
    state: ['document', 'ui'],                   // dev accessor sections (dev target)
    durable: true,                               // adapter durable.read (below)
    url: true,                                   // default true
    screenshot: false,                           // true → before.png / after.png in the batch dir
    settle: async (page) => {},                  // optional condition; default: quiescence
    expect: 'change' | 'none' | { 'state.document.revision': (v, before) => v > before },
  }
  ```
- **Sequence:**
  1. Read everything watched ("before").
  2. Run `action` inside `step(name)`.
  3. Settle: the adapter's `settle(page)` if given; otherwise quiescence, meaning no same-origin
     request in flight (from E1's ring) and two animation frames, within 5 s. Never a fixed sleep.
  4. Read everything again ("after").
  5. Compute a bounded structural diff.
- **Diff format:** `{ changed: [{ path, before, after }], unchanged: [path], truncated }`. Values
  are shortened to 200 characters, and there are at most 50 entries.
- **`expect`:**
  - `'change'` fails with "no watched change" when every watched target is identical, which is the
    silent no-op.
  - `'none'` fails when anything changed (cancel paths, disabled controls, read-only views).
  - An object asserts specific paths.
- **Record** into the batch report as `effects[]`, and into E1's timeline.
- **CLI form,** for agents driving single CLI actions rather than batches:
  `web-harness effect --observe '.move-tree' [--state document] [--expect change] -- click e12`.
  It runs the watched reads, the `cli` action, settle, and the reads again, then prints the diff.
- **Production target:** `state` is `unsupported` (`src/inspect.mjs:98-105`), so `effect` uses
  `observe`, `url` and `durable`, and says which watches were unsupported rather than silently
  dropping them.
- **Adapter `durable.read`** (SERIALIZED, production-safe and read-only): the app's own persisted
  summary. For example, chess reads the IndexedDB `kv` store; chorequest can count OPFS SQLite rows
  through a read-only path if one exists. This is optional: without it, `durable` is `unsupported`.
  **Open question:** how training-log and tabletop can read OPFS SQLite from the page without going
  through the app's worker. If they can't, `durable` stays unsupported there and the visible UI is
  the proof.
- **Honesty:** before and after are sequential reads with timestamps, not a transaction.

**Acceptance (on `examples/minimal`).**
- Clicking Save with `expect: 'change'` and `durable: true` passes, and the diff shows the stored
  value.
- Clicking a disabled button with `expect: 'change'` fails with "no watched change".
- Cancelling a dialog with `expect: 'none'` passes.
- The diff stays within its bounds on a large region.
- The CLI form works for `click`.

### E3. Retries are attempts; flaky is not verified

**Why.** Design review section C: "Record retries as separate attempts. A passing retry does not
erase an earlier failure."

**Today.**
- `scenarios` accepts `flaky` as a pass (`src/scenarios.mjs:128`). It reads only the final status
  per test (`src/scenarios.mjs:70`), so individual attempts are lost.
- Three consumers retry once in CI: training-log (`playwright.config.ts:7`), tabletop (`:11`),
  chorequest (`:7`). A test that fails and then passes is green, and the scenario is `verified`.
- Their traces are `on-first-retry` (training-log `:15`, tabletop `:20`, chorequest `:21`). That
  records the retry, not the failing attempt, so the failure itself has at best a screenshot or
  video.

**Design.**
- `flattenResults` keeps attempts: `attempts: [{ retry, status, ms, error }]` per row, from
  Playwright JSON `tests[].results[]`.
- New scenario status `flaky`. It is a problem (exit 1) unless `--allow-flaky` is passed, which
  prints every flaky scenario and records the flag in `scenarios.json`. `verified` requires every
  run of every cover to be `expected` with no failed attempt.
- A1 sets `failOnFlakyTests: Boolean(process.env.CI)`, a Playwright config option present in 1.63
  (`failOnFlakyTests?: boolean` in `playwright/types/test.d.ts`), so the suite itself fails too.
- Controller batches never retry on their own. When an agent reruns a batch with the same
  `sourceDigest` (already computed, `src/controller.mjs:305`) within one run, the report gets
  `attempt: n` and `priorAttempts: [{ batchId, ok, error }]`, so a later pass shows the earlier
  failure.

**Acceptance.**
- A crafted report where a test fails and then passes makes `scenarios --results` exit 1 with
  "flaky".
- `--allow-flaky` exits 0 and still lists the scenario as `flaky`.
- A batch that fails, is rerun unchanged and passes reports `attempt: 2` with the prior failure.

### E4. Expected and allowed faults inside batches

**Why.** Section D: "Expected faults must be scenario-local, narrowly matched and counted; missing
expected faults fail too. Record all faults even when expected." The Playwright fixture does this;
controller batches do not.

**Today.**
- A batch fails on any retained fault that the project-wide policy does not excuse
  (`src/batch.mjs:38-39`).
- `createHarnessTest` has `allowPageFaults` and `expectPageFault` (`src/playwright.mjs:26-36,
  65-70`) with `unmetExpectations` (`src/faults.mjs:111`).
- An agent deliberately exercising an error path (offline save, invalid import, a stubbed 500)
  gets a failed batch even when the app behaved correctly. The only escape is editing
  `faults.allowed` in `harness.config.mjs`, which excuses the fault for every session and test.

**Design.**
- Batch helpers `allowFault(pattern)` and `expectFault(kind, pattern)`, with the same semantics as
  the fixture: `failures(records, policy, local)` plus `unmetExpectations`.
- Scope: only faults recorded after the batch started (by E1's fault `seq`). Earlier faults cannot
  be excused from inside a later batch.
- Report: `expectedFaults: [{ kind, pattern, met, matched: n }]` and `allowedFaults: [...]`. Every
  record is kept.
- Persistence: excused records are marked (`excusedBy: batchId`) in the context's records, so a
  later `check` (`src/controller.mjs:599-673`) does not fail on them, and a `restart` carries the
  mark into `retainedFaults`.

**Acceptance.**
- A batch that triggers a 500 with `expectFault('http', /500/)` passes.
- The same batch without the helper fails.
- An `expectFault` that never fires fails with "expected http matching /500/ never occurred".
- A `check` after the passing batch reports zero faults and still lists the record.

### A1. Shared Playwright preset

**Why.** Failure evidence in the four E2E suites differs by accident, not by design:

| Consumer | retries (CI) | trace | screenshot | video |
|---|---|---|---|---|
| training-log | 1 | on-first-retry | only-on-failure | retain-on-failure |
| tabletop | 1 | on-first-retry | only-on-failure | — |
| chorequest | 1 | on-first-retry | only-on-failure | retain-on-failure |
| chess-mcp | — | — | — | — |

(`playwright.config.ts` in each; chess at `apps/ui/playwright.config.ts`.) A red chess E2E run in
CI carries only the error message.

**Design.**
- Export `harnessPlaywright(harness, overrides)` from `@azeajr/web-harness/playwright`. It returns
  config fields to spread:
  - `forbidOnly: CI`
  - `retries: CI ? 1 : 0`
  - `failOnFlakyTests: CI` (E3)
  - `use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure',
    timezoneId, locale }`, with the last two from P1
  - `reporter`: list and html, plus json when `PLAYWRIGHT_JSON_OUTPUT_NAME` is set (the container
    already sets it, `src/container.mjs:264`).
- `retain-on-failure` keeps the trace of the attempt that failed, which is the evidence `on-first-
  retry` misses.
- Keep one retry: the rerun shows whether the failure reproduces, and `failOnFlakyTests` keeps it
  from turning green.
- Document the preset in `docs/HARNESS.md` and the README.

**Acceptance.** All four consumers adopt it (Appendix A). A deliberately failing test in each
produces `trace.zip` for the failing attempt, plus E1's network and console attachments.

---

## M2 — Offline-first proof

### O1. Update flow in the production smoke

**Why.**
- The design review's production tier lists "worker/SW update flows".
- All four consumers use `registerType: 'prompt'`: training-log `vite.config.ts:79`, tabletop
  `:52`, chorequest `:41`, chess `apps/ui/vite.config.ts:24`. A new deploy must wait for the user.
- Failure modes nothing checks today:
  - the new worker is never detected;
  - the prompt never appears;
  - the new worker activates without consent;
  - activation deletes user data (an over-eager cache cleanup);
  - a reload loop;
  - the old tab breaks while the new worker waits.

**Today.**
- The smoke's phases are headers, bundle, globals, sw, persist, offline and faults
  (`src/smoke.mjs:11-21`). There is no second version.
- Only chess tests updates, in its own `apps/ui/test/pwa-lifecycle.mjs`, which runs in chess CI
  (`chess-mcp/.github/workflows/ci.yml:126-128`). It builds two instrumented versions (A and B) and
  checks that B waits, that a running operation defers the prompt, and that "Later" then "Reload"
  lands on B.

**Design.** A new smoke phase, `update`, after `offline`:
1. **Version B without a rebuild.** Copy the dist to a sibling directory and change only the
   service-worker script's bytes: append `// web-harness update probe <nonce>` to the file named by
   `smoke.update.sw` (default `sw.js`). The browser byte-compares the script, so this is a new
   version. Version A stays exactly the artifact that ships. The limit: the precache manifest is
   unchanged, so this proves the lifecycle, not the fetching of new assets. A project that wants a
   genuinely different B provides `smoke.update.build(outDir)`, as chess does with its build IDs.
2. **Swappable server.** `createStaticServer` (`src/static-server.mjs`) gains `swap(dir)`, which
   atomically points the server at another directory.
3. **Detection.** With A controlling the page and the persist token present, swap to B, call
   `registration.update()` from the page, and poll from Node (not `waitForFunction` with an async
   predicate; see `docs/HARNESS.md:54-56`) until `registration.waiting` is non-null. Fail after
   30 s with "no waiting worker".
4. **A keeps working.** The controller's script is still A's. The adapter's `verify(page, token)`
   passes, and no fault was recorded.
5. **Consent.** The adapter's `smoke.update.prompt(page)` must find the visible prompt (for
   example "A new version is ready") within 10 s. Then `smoke.update.accept(page)` clicks it. If a
   `controllerchange` fires before accept, the phase fails with "activated without consent" (in
   `'prompt'` mode).
6. **Activation.** After accept, wait for `controllerchange` and the reload. Then
   `registration.waiting` is null, the active worker's script contains the nonce (fetched through
   the page), `verify(page, token)` still passes (activation kept the user's data), and there was
   at most one navigation in the following 5 s (no reload loop).
7. **Optional "Later".** When `smoke.update.dismiss(page)` is given: dismiss, reload, and expect the
   prompt to return (as chess checks today).
8. **Faults.** The same fault policy applies throughout, and the phase is recorded in the report.

Config:
```js
smoke: { update: { sw: 'sw.js', mode: 'prompt', prompt, accept, dismiss, build } }
// update: false skips the phase; mode 'auto' expects activation without a prompt
```

**Acceptance.**
- `examples/minimal` passes, and so do all four consumers once they add their `prompt`/`accept`
  hooks.
- Reverse checks on the example, each failing the named step:
  - `self.skipWaiting()` in the worker under `prompt` mode → "activated without consent" (step 5);
  - a prompt that never renders → step 5;
  - an `activate` handler that deletes the app's data cache or database → `verify` fails (step 6);
  - `sw.js` served with a year-long `Cache-Control` → "no waiting worker" (step 3; see O2).

**Note.** chess keeps its instrumented lifecycle test: operation deferral is app-specific. This
phase is the common floor for every consumer, not a replacement.

### O2. Smoke: back online, and header values

- **Back online.** The offline phase switches the network back on and passes without looking
  (`src/smoke.mjs:132-140`). Add: reload while online, `ready`, `verify(page, token)`, and no
  `requestfailed` after reconnecting. An optional `smoke.reconnect(page)` covers apps that do
  something on reconnect (chorequest's sync talks to `/api/`, which is unserved here, so for it this
  step only proves nothing breaks).
- **Header values, not just presence.** Today the smoke checks that each required header exists on
  `/` (`src/smoke.mjs:68-71`). Allow per-path rules with value patterns:
  ```js
  requiredHeaders: {
    '/': ['x-content-type-options', { name: 'content-security-policy', match: /script-src 'self'/ }],
    '/sw.js': [{ name: 'cache-control', match: /no-cache|max-age=0/ }],   // a cached SW blocks updates
    '/assets/*': [{ name: 'cache-control', match: /immutable/ }],          // first matching file
  }
  ```
  The array form stays valid and means `/` only.
- **Acceptance.** The example with a CSP missing `script-src` fails `headers`. The example with a
  long-cached `sw.js` fails both `headers` and O1.

---

## M3 — Determinism and provenance

### P1. Clock, timezone and locale

**Why.**
- Design review section D: "Fix clock/locale/timezone … also run targeted timezone/DST variants
  where the product depends on local dates."
- Section C: the manifest records "clock, timezone, locale".
- Several consumers are date-driven: training-log (sessions, cycles), chorequest (daily quests,
  day rollover), tabletop (session history).

**Today.**
- Nothing in web-harness: there is no config field (`types/config.d.ts:54-111`), no controller
  option, and nothing in the manifest.
- chorequest does it itself:
  - `page.clock.setFixedTime` inside its fixture's `apply` (`chorequest/harness.config.mjs:19`),
    which is lost after `restart` (its own comment at `:17`);
  - `timezoneId: 'UTC', locale: 'en-US'` in its Playwright config
    (`chorequest/playwright.config.ts:19-20`);
  - its `ROADMAP.md:270` notes that UTC-only runs make the browser suite blind to local-day bugs.
    Its unit tests do run off-UTC in CI (America/New_York and Pacific/Kiritimati lanes).
- The other three pin nothing.

**Design.**
- **Config:**
  ```js
  environment: {
    timezoneId: 'America/New_York',
    locale: 'en-US',
    clock: 'real' | 'fixed' | 'install',   // default 'real'
    now: '2026-03-08T06:30:00Z',           // required for fixed/install
  }
  ```
  - `fixed`: `page.clock.setFixedTime(now)`. `Date` is frozen and timers still run, which is what
    chorequest uses.
  - `install`: `page.clock.install({ time: now })`. Timers are controlled, and batches get a
    `clock` helper (`runFor`, `fastForward`, `pauseAt`, `resume`) for rest timers (training-log)
    and day rollover (chorequest).
- **Controller.**
  - `timezoneId` and `locale` go through the Playwright CLI's `open --config` file. The controller
    writes it into the session directory; `--config` is already refused as a user `cli` argument at
    `src/controller.mjs:1056`, which stays.
  - The clock is applied in `openBrowser()` (`src/controller.mjs:677-699`), before the fixture. So
    `restart` re-applies it, which fixes the pin chorequest loses today.
  - `restart` keeps the same `now` under `fixed`. It is documented that "restart" with a frozen
    clock means the same instant.
- **Overrides:** `start --timezone Pacific/Kiritimati --locale en-GB --now 2026-11-01T05:59:00Z
  --clock install`. Overrides are part of the seed digest, so `reset` refuses a changed environment
  like a changed fixture.
- **Playwright:** A1 reads the same config. `WEB_HARNESS_TIMEZONE` and `WEB_HARNESS_LOCALE`
  override it, and `web-harness e2e --timezone X` passes them into the container (next to the
  existing `-e` list, `src/container.mjs:256-269`), so the whole suite can run in another zone.
- **Recommended variants** (documented, and run by G2): US spring-forward (2026-03-08 02:00 local),
  US fall-back (2026-11-01 02:00 local), Pacific/Kiritimati (UTC+14, the date line), and
  Pacific/Pago_Pago (UTC−11).
- **Manifest:** records the effective environment (P2), read back from the page
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`, `navigator.language`, `Date.now()`), not
  the requested one.

**Acceptance.**
- A session started with `--timezone Pacific/Kiritimati` reports that zone from the page, and so
  does the manifest.
- `restart` keeps the zone and the clock.
- `e2e --timezone` changes `resolvedOptions().timeZone` inside tests.
- chorequest can delete its own `setFixedTime` from `apply` and keep passing.

**Open question (verify first).** Whether the Playwright CLI's config file accepts context options
such as `timezoneId` and `locale` (the CLI's `open` help lists `--config` but not its schema). If
it does not, there is no cheap fallback: a live context's timezone cannot be changed from
`run-code`, so the controller would have to launch the browser itself instead of through the CLI's
`open`. That is a larger change; decide before building. The clock part (`page.clock`) works either
way and can ship first.

### P2. Run manifest v3

**Why.** Design review section C lists the fields a run manifest must carry so that any artifact
can be attributed to exact code, build, environment and resources.

**Today.** `session.json` is schema 2 (`src/controller.mjs:877,886-903`), copied to the run's
`manifest.json` once the seed is applied (`src/controller.mjs:749-752`).

- **It has:** project, root, session, token, target, image and imageId, browser, device and the
  device descriptor (viewport and DPR), seed (fixture, digest, URL, options, setup), workflow,
  status, server process identity, container ID, profile directory, retained faults, runId, runDir,
  build `{ outDir, digest }` (production only), postconditions, and `source: { commit, worktree }`,
  where `worktree` is `git status --short` text (`src/controller.mjs:743-746`).
- **Missing against the review:**
  - `attemptId` and `scenarioId`;
  - a digest of uncommitted changes (the status text shows which files changed, not what they
    contain);
  - the Playwright and Node versions (printed by `preflight` at `src/controller.mjs:449-451` but
    not stored);
  - resource limits (constants at `src/controller.mjs:67-70`, not stored);
  - clock, timezone and locale;
  - timings for `start`, `restart` and `reset`;
  - the cleanup outcome (only in `events.jsonl`);
  - an artifact index;
  - truncation flags.

**Design.**
- Schema 3, published as `schemas/run-manifest.v3.json` (added to `files` in `package.json`):
  ```text
  schemaVersion: 3, runId, sessionId, project, target, workflow
  source:      { commit, branch, dirty, dirtyDigest }
  build:       { digest, outDir } | null
  fixture:     { name, digest }   setup: { path, digest } | null
  environment: { timezoneId, locale, clock, now }            (P1, as read from the page)
  browser:     { name, device, viewport, dpr, userAgent }
  image:       { ref, id }        driver: { playwright, node }
  limits:      { containerMemory, containerCpus, serverHeapMb, forcedResources }   (H1)
  identities:  { origin, server: { pid, start }, containerId, profileDir }
  state:       starting | ready | restarting | resetting | stopped      (session lifecycle)
  status:      P3 vocabulary                                            (outcome)
  timings:     { preflight, build, serverReady, container, open, fixture, total }
  attempts:    [{ batchId, attemptId, scenarioId, sourceDigest, status, report }]
  artifacts:   [{ path, kind, bytes, truncated }]
  cleanup:     { status, errors } | null
  ```
- `dirtyDigest` = sha256 over `git diff HEAD --binary` plus the sorted `(path, sha256)` of each
  untracked, not-ignored file. The token is never printed; it stays in `session.json` only.
- `run FILE --scenario ID` validates the ID against `config.scenarios` and stamps it on the attempt.
- Migration: a schema 2 session is refused with "stop it with the previous version, then start";
  the check at `src/controller.mjs:871-879` already refuses unknown schemas.

**Acceptance.**
- A unit test validates a produced manifest against the JSON schema.
- `dirtyDigest` changes when a tracked file is edited and when an untracked file is added, and
  stays the same when nothing changed.
- A manifest from `examples/minimal` in G1 validates.

### P3. One status vocabulary

**Why.** Section C: status is one of `passed`, `failed`, `infrastructure_failed`, `not_run`,
`unsupported`. Section D: "Distinguish infrastructure failure from application failure, not merely
by error-message guesswork."

**Today.** Each piece has its own vocabulary:

| Piece | Outcome fields |
|---|---|
| Batch | `ok: true/false`, `controllerError`, `diagnosticsError` (`src/batch.mjs:49`, `src/controller.mjs:283-298`) |
| Session | `starting`, `ready`, `restarting`, `resetting`, `infrastructure-failed`, `cleanup-failed`, `stopped` |
| Smoke | `ok` plus per-check `ok` |
| Scenarios | `verified`, `mapped`, `unsupported`, `not-run` (`src/scenarios.mjs:31,133`) |
| Verdict | pass/FAIL |

**Design.**
- `src/status.mjs` exports `STATUS = { passed, failed, infrastructure_failed, not_run, unsupported }`
  (plus `flaky` for scenarios, E3).
- Every report (batch, `faults.json`, smoke `report.json`, `scenarios.json`) carries `status`.
  `ok` stays for one minor version for compatibility.
- A batch's transport or health failure is `infrastructure_failed`, and an assertion or fault is
  `failed`, decided by where the error came from (the transport `catch` at
  `src/controller.mjs:283-291` versus the page-side `error`), not by the message.
- Session lifecycle moves to `state` (P2) so it is not confused with an outcome.

**Acceptance.** A table-driven unit test covers each source of failure and the status it maps to.
G1 case 4 reports `failed`; killing the container mid-batch reports `infrastructure_failed`.

### P4. Scenario report tied to revision and build

**Why.** Design review delivery step 3: "evidence is tied to current revision". Section C: "`report`:
join scenario IDs to results for the exact source/build."

**Today.**
- `scenarios.json` is `{ project, results, problems }` (`src/scenarios.mjs:136-139`), with no
  commit, build digest or digest of the results file.
- `{ lane: 'smoke' }` covers are accepted without looking at anything
  (`src/scenarios.mjs:104-106`). The CI `verdict` holds the lane to success, but locally the report
  cannot tell.

**Design.**
- `scenarios.json` gains `source: { commit, dirty, dirtyDigest }` (P2),
  `results: { path, digest, playwright, startTime }` from the report's `config` and `stats`, and
  `build: { digest }`.
- `--lane smoke=.web-harness/smoke/report.json` checks that report: `status: passed` and the same
  build digest. A lane cover without its report is `mapped`, never `verified`.
- `--build-digest SHA`, or a digest read from the smoke report, is compared with the digest the E2E
  run tested. With `WEB_HARNESS_PREBUILT=1` the suite tests the checks job's artifact, so the
  container run records that digest. A mismatch is a problem: the scenario was proven on different
  bytes.

**Acceptance.** Mismatched digests exit 1 and name both. A missing lane report downgrades the
scenario to `mapped` and, with `--results`, exits 1.

### P5. Reconcile after an unknown outcome

**Why.** Section C: "If a transport timeout leaves the action's status unknown, require
reconciliation before replaying a mutation."

**Today.**
- A `docker exec` of a batch times out after 180 s (`src/controller.mjs:244`). A transport failure
  becomes `ok: false` with `controllerError` (`src/controller.mjs:283-291`).
- Nothing records that the batch's mutating steps may have run. Rerunning it can apply them twice
  (a set logged twice, a quest completed twice).

**Design.**
- A transport failure with no page-side report sets `outcome: unknown` in the batch report and
  `pendingReconciliation: { batchId, sourceDigest, at }` in the manifest.
- While that is pending, `run` is refused with "the last batch's outcome is unknown; run
  `web-harness reconcile` or pass `--after-unknown`".
- `reconcile` runs the read-only captures of an E1 bundle (screenshot, state, storage, aria,
  network since the batch started), writes them to `batch-<id>/reconcile/`, prints a summary, and
  clears the flag.
- Read-only commands (`observe`, `state`, `screenshot`, `check`, `status`) and `stop` stay allowed.

**Acceptance.** A batch that sleeps past a lowered timeout (`WEB_HARNESS_CLI_TIMEOUT_MS`, a new
setting used for this test) leaves `pendingReconciliation`, and the next `run` is refused.
`reconcile` clears it and writes the captures.

### P6. Redaction

**Why.** Section C: "Redact credentials, headers and private document content by default." E1 makes
this matter: it adds request logs, and traces carry full request and response bodies and headers
(Playwright CLI tracing reference).

**Today.** Nothing redacts. Fault details carry full URLs, including query strings
(`src/browser.mjs:39-44`, `src/watch.mjs:43-52`). The current evidence is mostly low-risk because
it is so narrow.

**Design.**
- One function, `redact(record, policy)`, in `src/evidence.mjs`, used by the rings, the fault
  recorders, the bundle writers and the manifest.
- Config and defaults:
  ```js
  evidence: {
    redact: {
      headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],   // never recorded
      query: [/token/i, /secret/i, /key/i, /code/i, /pair/i],            // values → [redacted]
      storageValues: false,                                              // keys only (E1)
    },
    trace: 'off' | 'retain-on-failure' | 'keep',
    uploadTraces: false,
  }
  ```
- Headers are recorded only when explicitly allowlisted, and bodies never in harness logs.
- Traces carry bodies, so `index.json` flags them, and the CI upload guidance (README) excludes
  `trace.zip` unless `uploadTraces: true`.
- `doctor` warns when `.web-harness/` is not ignored by git (`git check-ignore`).

**Acceptance.** A request to `/x?token=abc&page=2` is recorded as `/x?token=[redacted]&page=2` in
faults, the ring and the bundle. An `Authorization` header appears nowhere. `doctor` warns in a repo
that does not ignore `.web-harness/`.

### H2. Isolate the host server's environment

**Why.** Section A: "Isolate HOME/XDG and browser state." From herdr's cautions: a lab that isolated
XDG but not HOME could still write into the real home directory.

**Today.**
- The browser side is isolated: containers run with `HOME=/tmp` and the user's UID
  (`src/controller.mjs:942-945`, `src/container.mjs:254-267`, preflight probe
  `src/controller.mjs:421-424`).
- The host server, which runs the dev server or the static server, inherits the whole environment
  (`src/controller.mjs:498-505`): the real `HOME`, `XDG_*`, `~/.npmrc`, and any exported
  credentials (`GH_TOKEN`, `CLOUDFLARE_API_TOKEN`, and so on). A Vite plugin or a dev command can
  read those or write under the real home.

**Design.**
- The environment is built from an allowlist, not inherited:
  - `PATH`, `LANG`, `LC_*`, `TERM`, `NODE_OPTIONS`, `COREPACK_HOME`;
  - `npm_config_store_dir`, set to the real pnpm store (`pnpm store path`, resolved once in
    preflight) so `pnpm exec` does not try to rebuild a store;
  - the controller's `WEB_HARNESS_*` variables;
  - anything named in a new adapter field, `dev.env: ['VITE_*', 'MY_VAR']`.
- `HOME` = `<session>/home`, with `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` beneath
  it, created per session and deleted by `stop`.
- Anything matching `/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i` is dropped even if a wildcard
  would allow it, unless listed by exact name.

**Acceptance.**
- A dev command that prints its environment shows `HOME` under the session directory and no
  secret-named variables.
- The dev targets of all four consumers still start (checked by hand, then G1 on the example).

**Open question.** Whether each consumer's `pnpm exec vite` / `npx vite` works without the real
`HOME` (npm cache location, a private registry in `~/.npmrc`). Verify per consumer before making
this the default. If one breaks, `dev.env` or an explicit `dev.home: 'real'` escape covers it,
and the manifest records it.

---

## M4 — Agent ergonomics

### A2. Agent skill shipped with the package

**Why.**
- chess-mcp has `.agents/skills/ux-review/SKILL.md` (22 lines, pointing at its `docs/UX_REVIEW.md`).
- training-log, tabletop and chorequest have no skill that tells an agent the harness exists or how
  to use it; training-log has only a paragraph in `CLAUDE.md`.
- The rules that make agent evidence trustworthy live in `docs/HARNESS.md` and are easy to skip:
  zero faults is not completion, inspect the PNG, record every attempt, promote to a test, one heavy
  job at a time.

**Design.**
- `skills/web-harness/SKILL.md` in the package (added to `files`). It is generic:
  - when to use the harness;
  - the loop;
  - the commands and what each proves;
  - the evidence rules (the run's `review.md`, inspecting images, E1 bundles, E2 effects);
  - host safety (H1 and `doctor`);
  - proof boundaries (emulated WebKit is not iOS).
  Project specifics are not copied into it.
- `web-harness describe --json` prints what an agent needs about this project, read from the
  config: fixtures and descriptions, state sections, scenarios with status, targets, ports, the
  E2E port, smoke hooks present, and the commands. The skill tells the agent to run it first.
  `help` already prints fixtures (`src/controller.mjs:108-139`); this is the machine-readable form.
- `web-harness skill install [--dir .claude/skills | .agents/skills]` copies the skill (a copy, not
  a symlink, because node_modules paths change) with a version header. `doctor` warns when the
  installed copy's version differs from the package's.
- A consumer keeps a project skill (like chess's `ux-review`) for app-specific journeys, and it
  links to the shared one.

**Acceptance.**
- A unit test checks that every command the skill mentions exists in the CLI's command list
  (`commands` in `src/core.mjs:11`), so the skill cannot drift from the CLI.
- Installed in the three consumers that lack a skill (Appendix A).

### A3. Promote a batch into a test

**Why.** The last step of the loop: "promote the reproduction into an ordinary test"
(`docs/HARNESS.md:5-8`), and "exploration is not coverage until it lands as a test"
(`docs/HARNESS.md:106-107`). Today it is manual, so it is often skipped.

**Design.**
- A Playwright-side fixture helper first, useful on its own:
  `applyHarnessFixture(page, harness, name)` in `@azeajr/web-harness/playwright`. It runs the
  adapter's `fixtures[name].prepare` then `apply` in a test, the same path the controller uses
  (`src/browser.mjs:87-103`), so tests and sessions share fixtures instead of duplicating seeding
  code. Test code runs in Node, so `prepare` output can be written to a temporary `dataFile`.
- `web-harness promote BATCH_FILE --to tests/e2e/<name>.spec.ts --title "…" [--fixture NAME]
  [--scenario ID]` generates a spec that:
  - imports the project's `test` (from config `e2e.fixtures`, for example `tests/e2e/fixtures.ts`);
  - calls `applyHarnessFixture`;
  - inlines the batch function;
  - maps `step` to `test.step`, `assert` to `expect(cond, message).toBeTruthy()`, and
    `observe`/`state`/`effect` to exported helpers with the same behaviour.
  It prints the `covers` entry to add under the scenario rather than editing the config.
- Optional: `web-harness record` wraps the Playwright CLI's `recording-start`/`recording-stop`
  (present in 1.63) to turn a sequence of manual `cli` actions into a batch file, which can then be
  promoted.

**Acceptance.** A batch from G1 promoted into `examples/minimal` passes under `web-harness e2e`, and
`scenarios --results` maps it as `verified`.

### A4. Accessibility scan

**Why.** No consumer runs an accessibility check. `check` covers faults and overlays rendered
off-screen only (`src/controller.mjs:599-673`, `src/browser.mjs:141-175`). An agent reviewing a
phone layout currently has no signal for unlabeled controls or low contrast.

**Design.**
- `axe-core` becomes an optional peer dependency.
- Controller: `check --a11y`, or the config below. The controller reads `axe.min.js` from the host's
  `node_modules` and ships it into the page through the `run-code` file (run-code cannot import),
  then runs `axe.run(document, options)`.
  ```js
  a11y: { impact: 'serious', disable: ['color-contrast'], include: ['main'] }
  ```
- Violations at or above `impact` become faults of a new kind, `a11y`, carrying the rule ID, target
  selector, count and help URL. Lower-impact violations become warnings.
- Playwright: a `checkA11y(page, options)` fixture helper with the same config and classification.
- Smoke: an optional `a11y` phase on `/` after `load`.
- Proof boundary: automated rules find a subset of WCAG problems. A clean scan does not certify
  accessibility, and the report says so.

**Acceptance.** An unlabeled icon button in the example is an `a11y` fault in `check --a11y`, in the
fixture and in the smoke. `disable: ['button-name']` excuses it, and the record is still kept.

---

## M5 — Extended tier and measurement

### G2. Reusable extended workflow

**Why.**
- The design review's extended tier: "browser/device matrix, fault/recovery, heavy data, stress,
  mutation — selected PRs plus scheduled/release coverage; failures visible and triaged."
- Its chorequest section: "CI runs plain unit tests, not its coverage/mutation scripts."

**Today.**
- `web-harness mutate` exists and runs in a throwaway copy (`src/mutate.mjs:9-12`).
- training-log and chorequest define `test:mutation`, but no consumer runs it on a schedule.
- No timezone variants of the browser suite run anywhere (see P1).
- There is no device matrix beyond each suite's own projects.

**Design.**
- `.github/workflows/extended.yml` with `on: workflow_call` and these inputs:
  - `mutation` (bool) and `mutation-threshold` (number; fail below it);
  - `timezones` (a JSON list; runs `web-harness e2e --timezone X` for each, needs P1);
  - `projects` (a JSON list of Playwright projects);
  - `node-version`.
- Jobs: `mutation` (upload the Stryker report, compare its score with the threshold) and
  `e2e-matrix`.
- Triage: on a scheduled failure, open or update one issue per consumer titled "extended: <job>
  failing" through `gh` (needs `issues: write`), and close it on the next green run. Failures are
  visible without being a required check.
- A consumer adds about ten lines: `on: { schedule: [{ cron: … }], workflow_dispatch: {} }` and
  `uses: Azeajr/web-harness/.github/workflows/extended.yml@vX`.

**Acceptance.** training-log runs it nightly for a week with a mutation report artifact each night.
A threshold set above the current score fails the run and opens the issue; the next green run
closes it.

**Open question.** Runner minutes. chorequest is private on a free plan: 2,000 minutes a month and
2-core runners. Schedule it weekly there, and measure a run first.

### H3. Measure the harness itself

**Why.** Design review section F: "Measure equivalent scenarios: startup, warm
interaction/inspection, reset, persistent restart, end-to-end journey, output volume, peak memory
and CPU … derive budgets from measurements rather than arbitrary universal targets."

**Today.**
- A batch reports `totalMs`, `transportCalls`, `transportMs` (`src/controller.mjs:307-311`) and
  `executionMs` (`src/batch.mjs:50`).
- `start`, `restart` and `reset` are not timed.
- Memory and CPU are not sampled.

**Design.**
- Phase timings in the manifest (P2 `timings`), and in `events.jsonl` for `restart` and `reset`.
- At the end of each command, a peak-memory sample: `docker stats --no-stream` for the owned
  container, and the server's `VmHWM` from `/proc/<pid>/status`. Recorded in `events.jsonl` as
  `metrics`.
- `web-harness bench [--repeat 5]` runs a fixed sequence on the current project:
  1. `start`;
  2. three `state` reads done separately, then the same three in one batch (the batching claim,
     measured);
  3. `reload`, `restart`, `reset`;
  4. `stop`.
  It prints the median and p90 per step with the conditions (host cores and memory, image,
  Playwright version, target). No budgets until there are baselines.

**Acceptance.** `bench` on `examples/minimal` produces repeated samples and conditions. The manifest
of a normal session carries phase timings and the peak memory of both processes.

---

## Appendix A — Consumer follow-ups (not web-harness work)

Kept here so they are not lost. Each happens in the consumer's own repository, through a PR.

- **Version bumps.** training-log and tabletop are on v0.1.2; they lack the CPU clamp (v0.1.3) and
  the rehoming of container results (v0.1.4). chess-mcp is on v0.1.3. Bump each to the latest tag,
  in the dependency and in every `uses:`, together.
- **chess-mcp E2E evidence.** Its Playwright config has no retries, trace, screenshot or video.
  Adopting A1 fixes it; until then, add them directly.
- **Skills.** Install A2 in training-log, tabletop and chorequest. chess-mcp links its `ux-review`
  skill to the shared one.
- **Update-flow hooks.** Each consumer adds `smoke.update.prompt`/`accept` for its own prompt (O1).
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
| A | `doctor` | built; resource budget → H1 |
| A | `start --target` | built |
| A | `run` with step history | built; attempts → E3 |
| A | `observe`, `state` | built |
| A | `effect` | **E2** |
| A | `check` | built; a11y → A4 |
| A | reload / restart / reset / stop | built |
| A | `report` for the exact source/build, keeping failed attempts | partly built (`scenarios`); **P4**, **E3** |
| A | isolate HOME/XDG | browser built; host server → **H2** |
| A | cleanup failure is a harness failure | built |
| B | two targets, dev accessors read-only, production digest, same artifact validated and deployed | built |
| C | versioned manifest with the listed fields | partly built; **P2** |
| C | status vocabulary | **P3** |
| C | run directory with steps, faults, state, events, screenshots, optional trace | partly built; **E1** |
| C | redaction | **P6** |
| C | retries as attempts | **E3** |
| C | reconcile before replaying after an unknown outcome | **P5** |
| D | named fixtures through real import paths | built (adapter `fixtures`); in tests → A3 `applyHarnessFixture` |
| D | clock / locale / timezone, DST variants | **P1**, run by **G2** |
| D | one fault policy; expected faults local, counted, missing ones fail | built in tests; in batches → **E4** |
| D | infrastructure vs application failure by source | partly built (`infrastructure-failed`); **P3** |
| E | production tier: SW update flows | **O1** |
| E | production tier: offline/reconnect, security headers | offline and presence built; **O2** |
| E | extended tier on a schedule | **G2** |
| E | always-reporting aggregate verdict; deploy consumes the validated artifact | built |
| E | fail on focused-only tests | consumers set `forbidOnly`; preset → **A1** |
| E | mutation in isolation | built; scheduling → **G2** |
| F | warm session, batching, narrow state, build once | built |
| F | measure equivalent scenarios | **H3** |
| F | bound container and host separately | built; headroom → **H1** |
| Delivery 1 | controller acceptance in CI | **G1** |
| Delivery 2 | production restart journey | built (proven by hand in chess-mcp and training-log, 2026-09-27); automated → **G1** case 5 and 10 |
| Delivery 3 | scenario inventory and aggregate gate | built; tied to revision → **P4** |
| Delivery 4 | failure bundles explain a real induced defect | **E1** acceptance |

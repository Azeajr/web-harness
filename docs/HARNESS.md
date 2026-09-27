# web-harness guide

One harness for four offline-first Vite PWAs. It exists to close one loop:

> start an owned environment → apply a reproducible fixture through the real UI → act through
> visible controls → observe narrow state and visible effects → assert a terminal condition → keep
> a failure bundle → promote the reproduction into an ordinary test → verify the artifact that
> actually ships.

Every piece below serves a step of that loop. Where a piece cannot prove something, it says so.

## Pieces

| Command / export | Step | Proof boundary |
|---|---|---|
| `web-harness start/run/observe/state/check/…` | explore | A Linux Docker browser (pinned Playwright image) against an owned local server. Emulated devices, not real iOS. |
| `effect` (batch helper and command) | observe | What changed around one action — and that something did. Sequential reads, not one atomic snapshot. |
| failure bundles | keep evidence | Every request and console line (bounded, redacted), the accessibility tree, storage and service-worker state, a merged timeline, optionally a trace. |
| `createHarnessTest` (`/playwright`) | regress | The same fault policy as a session, in the project's Playwright suite. |
| `productionServer`, `web-harness serve` | regress, explore | The built bundle with `public/_headers` applied and SPA fallback, like Pages. No Pages Functions, no edge. |
| `web-harness smoke` | ship | This artifact's headers, bundle, SW control, persistence, offline reload — in Chromium. |
| `web-harness e2e` | regress | The project's suite in the pinned image; the one place pixel baselines are compared. |
| `web-harness scenarios` | ship | Each critical journey maps to a test that exists and (with results) passed — or says why not — for a named source and build. |
| `web-harness mutate` | regress | Stryker in a throwaway copy of the tree; never rewrites the checkout. |
| `scope` / `setup` / `verdict` actions | ship | The required check always reports, and a skipped required lane fails it. |

## Adapter: `harness.config.mjs`

Each project describes itself once. See `types/config.d.ts` for every field.

```js
import { defineHarness } from '@azeajr/web-harness/config'

export default defineHarness({
  name: 'training-log',                 // slug for sessions, containers, locks
  port: 5185,                           // session default; keep it apart from the E2E port
  defaults: { browser: 'webkit', device: 'iPhone 13 Mini' },
  dev: { command: (port) => [...], marker: '/src/main.tsx' },
  production: { build: (outDir) => [...] },
  ready,                                // SERIALIZED: app is interactive
  fixtures: { configured: { apply } },  // apply is SERIALIZED and drives the real UI
  state: { sections, defaults, read },  // read is SERIALIZED and runs in the page (dev only)
  durable: { read },                    // SERIALIZED, (page) => the app's persisted state; any target
  faults: { allowed, watchedWarnings, unservedPrefixes },
  evidence: { trace, redact: { query }, uploadTraces },
  environment: { timezoneId, locale, clock, now },  // sessions and harnessPlaywright
  smoke: { requiredHeaders, ready, persist, verify },
  e2e: { config, snapshots, prepare },
  scenarios: [...],
})
```

**SERIALIZED** functions travel as source text into Playwright CLI `run-code`, which has no module
scope and no `URL`, `Buffer` or `setTimeout` globals (wait with `page.waitForTimeout`). They may use `page`, their arguments, and ECMAScript
built-ins only. Method shorthand is fine; closures over the config file are not. Fixture data that
must reach a file input is written by the controller to `dataFile` (a `file` property in the
prepared data becomes that file's whole content).

**Waiting on async page state:** poll from Node with an awaited `page.evaluate` that returns a
boolean. `page.waitForFunction` with an async predicate is satisfied by the returned Promise even
when it resolves to `false` — a "wait until saved" written that way silently waits for nothing.
And never `indexedDB.open()` a database the app may not have created yet: that creates an empty
one at version 1, and the app's own upgrade never runs.

**State accessors** are development-only (`import.meta.env.DEV`), read-only (SELECT-only database
access), bounded summaries — never raw rows, tokens or documents. The production smoke fails if a
`__harness` or `__e2eResetDb` global ships. On the production target `state` answers `unsupported`
instead of inventing an answer: assert visible UI or durable storage there.

## Sessions

```sh
web-harness preflight                    # Docker, pinned image, device, port — installs nothing
web-harness start [--target production] [--fixture NAME] [--browser B --device D] [--port P]
                  [--timezone IANA --locale TAG --clock real|fixed|install --now ISO] [--trace MODE]
web-harness run FILE [--trace MODE] [--scenario ID]  # batched (page, {step, assert, observe,
                                         #   state, effect, allowFault, expectFault, clock}) => …
web-harness effect --observe SEL … -- CLI  # diff what is watched around one CLI action
web-harness reconcile                    # after a batch whose outcome is unknown
web-harness observe SELECTOR | state     # compact JSON
web-harness reload                       # same page, same storage
web-harness restart                      # close and reopen on the SAME profile (durability)
web-harness reset                        # new profile, same fixture digest, new run directory
web-harness screenshot LABEL [--full-page] | check | status | stop
web-harness cli <playwright-cli args>    # anything else, inside the owned session
```

- **Ownership.** Each session owns a port lease (host-wide, across projects), a server process
  (checked by PID, start time, cwd and entry before it is ever signalled), a labelled container,
  and an identity token served at `/__web-harness/identity`. A replaced server on the same port,
  or another worktree's server, is refused rather than driven. `stop` removes only what it owns.
- **Host environment.** The owned server (dev or static) does not inherit the developer's
  environment: tool variables (`PATH`, `LANG`/`LC_*`, `npm_config_*`, `COREPACK_*`, `TZ`, …) and
  whatever `dev.env` names pass; credentials (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, …)
  never pass unless named exactly; `HOME` and the XDG directories live in the session and are
  removed by `stop`. `dev.home: 'real'` opts out. The manifest records what passed.
- **Environment.** `environment` (or `--timezone`, `--locale`, `--clock`, `--now`) sets the
  browser's timezone and locale through the Playwright CLI's config and pins its clock on every
  open — so `restart` keeps the same instant. `fixed` freezes `Date` while timers run; `install`
  hands a batch the timers: its `clock` helper has `runFor(ms)`, `fastForward(ms | 'mm:ss')`,
  `pauseAt(time)`, `resume()`, `setFixedTime(time)` and `now()`, and says which mode a call needs
  rather than failing obscurely. What the page actually reports is read back into the manifest. The
  environment is part of the seed digest: `reset` refuses a changed one. Worth running where a
  product depends on local dates: US spring-forward (2026-03-08 02:00 local), fall-back
  (2026-11-01 02:00 local), `Pacific/Kiritimati` (UTC+14) and `Pacific/Pago_Pago` (UTC−11).
- **Targets.** `dev` runs the project's dev server with the Vite identity plugin. `production`
  builds into the session directory (the checkout's `dist/` is untouched), records the build's
  content digest, and serves it with the Pages-style server.
- **Lifecycles are different operations.** `reload` keeps the page's storage and memory.
  `restart` closes the browser and reopens the same persistent profile: OPFS, IndexedDB,
  localStorage, caches and the service worker survive, memory does not — the proof a saved
  document survives a relaunch. Faults from the closed lifetime are retained. `reset` deletes the
  profile and replays the fixture; it refuses a changed fixture or setup digest.
- **Batches.** `run` executes trusted repository code in the session: a failed `step` or `assert`
  stops the batch, a failure bundle is kept without masking the original error, and any retained
  fault fails an otherwise passing batch. Output over 16 KB is summarized; the full report stays
  in `batch-<id>/report.json`.
- **Attempts.** Running the same batch source again in the same run is another attempt: the report
  carries `attempt` and every `priorAttempts` outcome, so a later pass never hides an earlier
  failure.
- **Faults a batch causes on purpose.** `allowFault(pattern)` excuses, and `expectFault(kind,
  pattern)` excuses *and requires*, faults recorded during this batch only — never earlier ones.
  An expectation that never fires fails the batch. Excused records stay in every fault report,
  marked `excusedBy`, and later checks do not count them again. A batch lets what it started
  settle (its requests finish, the DOM goes quiet; at most 3 s) before judging faults, because
  faults trail their cause — the browser's own "Failed to load resource" line arrives after the
  response.

### `effect`: what an action changed

```js
await effect('save', () => page.getByRole('button', { name: 'Save' }).click(), {
  observe: ['#saved'],          // bounded observe() of each, reduced to text, visibility, attributes
  state: ['document'],          // dev accessor sections (unsupported on production, and said so)
  durable: true,                // the adapter's durable.read, on any target
  settle: (page) => …,          // optional completion condition; default below
  screenshot: false,            // true: effect-N-before.png / -after.png in the batch directory
  expect: 'change',             // or 'none', or { 'durable.note.revision': (now, then) => now > then }
})
```

It reads everything watched, runs the action as a step, settles, reads again, and records a
bounded diff (`changed` paths with before and after, `unchanged` count) in the report's `effects`.
`expect: 'change'` fails the quiet no-op — the click that did nothing — and `'none'` fails a cancel
or a disabled control that changed something. Without `settle`, it waits for same-origin requests
started by the action to finish, then for 150 ms without DOM mutations, then two animation frames,
at most 5 s, and reports `settled: false` rather than failing when it runs out. Storage writes are
invisible to the network check; pass `settle` (or `--until SELECTOR` on the command) when a
completion signal exists.

The command form wraps one Playwright CLI action for agents working command by command:
`web-harness effect --observe '#saved' --durable --expect change -- click e12`.

## Failure evidence

A failed batch keeps `batch-<id>/bundle/`; a failed `check`, `start`, `restart`, `reset` or
`reload` keeps `failure-<n>/` in the run directory. Each holds:

| File | What |
|---|---|
| `index.json` | the files, their sizes and drop counts, capture errors, and a `summary`: first counted fault, last failed requests, last console error, URL, a waiting service worker |
| `timeline.jsonl` | controller events, steps, faults, console lines and requests merged by time — read top to bottom |
| `network.jsonl` | every request since the batch began (plus 50 before it): method, URL, type, status, failure, duration, whether the service worker made it |
| `console.jsonl` | every console line at every level, with its location |
| `aria.yml` | the accessibility tree: what a person could see and reach |
| `storage.json` | storage estimate, localStorage/sessionStorage keys (never values), IndexedDB names and versions, cache names, the service-worker registration |
| `state.json`, `faults.json`, `screenshot.png` | the dev state read, every fault record (marked counted or not), the viewport |
| `trace.zip` | with `run --trace retain-on-failure` (or `start --trace …` for the session, or `evidence.trace`) |

Requests and console lines are kept in bounded rings on the browser context (2,000 and 1,000; the
oldest drop and are counted), so they survive reloads that the CLI's own logs do not. Query values
whose names match `token`, `secret`, `key`, `code`, `pair`, `auth`, `password`, `session` or
`evidence.redact.query` are replaced with `[redacted]` before they are recorded; headers and bodies
are never recorded — except in `trace.zip`, which Playwright writes with bodies and headers, so
`index.json` flags it and it should stay local. The captures are sequential: a screenshot and an
asynchronous state read are not one moment, and the bundle says so. The batch's stdout carries the
`summary` and the bundle path, so the first read is usually enough.

- **Unknown outcomes.** A batch whose transport fails before any page-side report (a CLI timeout,
  `WEB_HARNESS_CLI_TIMEOUT_MS`, default 180 s) may have mutated state. Its outcome is recorded as
  `unknown`, and the next `run` is refused until `reconcile` captures the page's current state
  beside that batch — or `run --after-unknown` says the caller knows.

### The manifest and the status vocabulary

`session.json` (and each run's `manifest.json`) is versioned: schema 3, documented in
`schemas/run-manifest.v3.json`. It records the source (`commit`, `branch`, `dirty`, and a
`dirtyDigest` over the uncommitted diff and untracked files), the build digest, the fixture/setup
digest, the requested and the effective environment, the image, device, driver versions and
resource limits, owned identities, start timings per phase, every batch attempt (with
`scenarioId` from `run --scenario ID`), the cleanup outcome and an artifact index (each file's
`kind`, size, and `truncated` when a bounded log dropped entries). A session's
lifecycle is its `state` (`starting`, `ready`, …, `stopped`). Outcomes everywhere — batch, `effect`,
`faults.json`, smoke `report.json`, `scenarios.json`, attempts — use one vocabulary: `passed`,
`failed`, `infrastructure_failed` (the harness's transport or health failed, decided by where the
failure came from, never by its message), `not_run`, `unsupported`, `flaky`.

### Completion evidence

`--workflow` labels artifacts; it never runs a journey. A seeded screenshot or a zero-fault `check`
does not establish that a workflow works. Record every attempt, failed ones included, with run IDs,
inspected images and the exact terminal state, in the run's `review.md`. Opening a PNG with an
image-capable tool is inspection; writing it is not. A full-page capture omits panes that scroll
inside themselves — `screenshot --full-page` names them; scroll and capture each. Reading hidden
text from the DOM proves it exists, not that a person can reach it.

Drive running → terminal transitions so a stale result cannot satisfy a wait. Use condition-based
waits, never sleeps. After a fix, `reset` and replay the same fixture, then promote the assertions
into the Playwright suite and run it — exploration is not coverage until it lands as a test.

## One fault policy

The controller (`installPolicy`), the Playwright fixture and the smoke (`watchContext`) classify
with the same functions from `src/faults.mjs`:

| Recorded as a fault | Not a fault |
|---|---|
| page errors, crashes | ordinary `console.warn` (kept as evidence) |
| `console.error`, watched warnings | requests to `unservedPrefixes` (answered 404, kept as evidence) |
| failed requests, same-origin HTTP ≥ 400 | a service worker's own fetch failing offline (smoke, offline phase only) |
| any external request (stubbed with JSON `null`) | `ResizeObserver loop` noise |
| layout overflow of menus/dialogs (`check`) | |

Project-wide `allowed` patterns excuse only page and console output. A test excuses its own induced
faults with `allowPageFaults(pattern)`, or requires them with `expectPageFault(kind, pattern)` — an
expected fault that never fires fails the test, so a failure path cannot silently stop being
exercised. Batches do the same with `allowFault` and `expectFault`. Fault checks run only on
otherwise-passing tests, whose own failure is usually clearer.

## Playwright suites

```ts
// playwright.config.ts
export default defineConfig({ ...harnessPlaywright(harness, { use: { ...devices['iPhone 13 Mini'] } }), … })
```

`harnessPlaywright` gives every suite the same evidence of a failure: `trace: 'retain-on-failure'`
(the trace of the attempt that failed — `on-first-retry` records only the retry), screenshot and
video on failure, `forbidOnly`, one retry in CI, and `failOnFlakyTests` in CI so that retry cannot
turn a flaky test green. `createHarnessTest` attaches `network.jsonl` and `console.jsonl` to every
failing test. `web-harness scenarios` reports a scenario whose test passed only on retry as
`flaky` — a failure unless `--allow-flaky` — and keeps every attempt in `scenarios.json`.

## Scenario reports name what they judged

`scenarios.json` records the source it ran against (commit and dirty digest), the results file
(by digest, with its Playwright version and start time) and the build. A lane cover
(`{ lane: 'smoke' }`) is `held-by-verdict` — the CI verdict holds that required job to success —
unless its report is given with `--lane smoke=.web-harness/smoke/report.json`; then the report
must have passed. Build digests from every source that has one (`e2e --prebuilt` records the
artifact's digest in `e2e-results.json`, the smoke report has its own, `--build-digest SHA` adds
one) must agree: evidence about two different builds fails. Scenario statuses: `verified`,
`verified-with-lane`, `held-by-verdict`, `flaky`, `mapped` (no results given), `unsupported`,
`not-run`.

## Production smoke

`web-harness smoke [--dist DIR]` serves the build and, in a fresh Chromium profile, checks in order:

1. **headers** — every rule in `smoke.requiredHeaders`: names on `/` (array form), or per path with
   value patterns, e.g. a CSP that still has `script-src 'self'`, a `sw.js` that is not
   long-cached, hashed assets that are `immutable` (`/assets/*` checks the first built file);
2. **bundle** — a production build (no Vite client, no `/src/`);
3. **globals** — no development accessor;
4. **sw** — a service worker controls the page after one reload;
5. **persist** — the project's `persist` action survives a reload;
6. **offline** — the same survives an offline reload;
7. **online** — back online, a reload still works and `reconnect` (if any) succeeds;
8. **update** — see below;
9. **faults** — nothing above faulted.

It writes `.web-harness/smoke/report.json` with the build digest, and on failure `failure.png`,
`network.jsonl` and `console.jsonl`.

**The update phase** publishes a second version on the same origin (the build with only the
service-worker script's bytes changed — or `smoke.update.build(outDir)`) and asks the registration
to update. In `prompt` mode (the default; every consumer's `registerType`) it requires that the new
worker is found and *waits*, that the old one keeps serving and the persisted data still verifies,
that nothing takes over without consent, then — with `smoke.update.prompt` and `accept` — that the
app's own prompt appears, accepting it activates the new worker, the data survives activation, and
the page reloads once, not in a loop. `dismiss`, when given, must bring the prompt back after a
reload. Without `prompt`/`accept`, activation is reported as not exercised. `mode: 'auto'` expects
the new version to take over by itself. The proof boundary: the second version proves the update
lifecycle, not the fetching of changed assets; a real second build covers that.

A long-cached `sw.js` does not stop an update in current browsers (update checks bypass the HTTP
cache by default), but it is still a deploy mistake worth failing: that is a header rule.

## CI shape

```
scope → checks (lint, typecheck, coverage, build → dist artifact + digest)
      → e2e ∥ smoke ∥ project lanes (each verifies the digest, never rebuilds)
      → verdict (always runs; the ONLY required status check)
      → deploy (default branch, deployable paths changed; needs checks + smoke; ships the artifact)
```

- **No `paths` filters on triggers.** A workflow that does not run never reports, and a required
  check that never reports blocks the PR forever. `scope` decides inside the run, with a skip-list
  for prose, so an unknown file counts as code.
- **`verdict`** fails if any needed job failed or was cancelled, or if a job listed as required
  for code changes did not succeed. A skipped job is never an accidental pass.
- **`deploy`** ships the digest-checked artifact that `checks` built and `smoke` proved. It does
  not wait for E2E, which is already required to merge; a flaky browser test cannot block a release
  of already-verified bytes.

## Limits

- Linux only (Docker host networking, `/proc` ownership checks).
- Container CPU bounds default to at most the host's cores (Docker refuses more): 4 for E2E, 2 for
  sessions. A private repository's GitHub-hosted runner has 2 cores.
- **Memory budget.** `start`/`preflight` and `e2e` read `/proc/meminfo` and refuse to start a
  container the host cannot hold: its bound (plus the host server's heap for a session) plus a
  margin must fit in `MemAvailable`, less what running harness containers may still grow into up to
  their own bounds. The margin is 1.5 GiB, or 2.5 GiB without swap, where memory pressure freezes
  the host instead of killing one process (`WEB_HARNESS_MEMORY_MARGIN` overrides it). `e2e` sizes
  its container to what is free, between 3 and 6 GiB, unless `WEB_HARNESS_E2E_MEMORY` sets it.
  `--force-resources` proceeds anyway and is recorded. Run one heavy job at a time regardless: the
  budget sees harness containers, not a browser suite started outside the harness.
- Emulated WebKit is not iOS Safari; installed-PWA behaviour, locked-phone timers and OS
  notification delivery need a real device — list them as `unsupported` scenarios.
- The static server does not run Pages Functions or `_redirects` (it refuses a build that has one).
- Batches, `--setup` files and fixture code are trusted repository code with full page access.

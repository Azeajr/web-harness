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
| `createHarnessTest` (`/playwright`) | regress | The same fault policy as a session, in the project's Playwright suite. |
| `productionServer`, `web-harness serve` | regress, explore | The built bundle with `public/_headers` applied and SPA fallback, like Pages. No Pages Functions, no edge. |
| `web-harness smoke` | ship | This artifact's headers, bundle, SW control, persistence, offline reload — in Chromium. |
| `web-harness e2e` | regress | The project's suite in the pinned image; the one place pixel baselines are compared. |
| `web-harness scenarios` | ship | Each critical journey maps to a test that exists and (with results) passed — or says why not. |
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
  faults: { allowed, watchedWarnings, unservedPrefixes },
  smoke: { requiredHeaders, ready, persist, verify },
  e2e: { config, snapshots, prepare },
  scenarios: [...],
})
```

**SERIALIZED** functions travel as source text into Playwright CLI `run-code`, which has no module
scope and no `URL` or `Buffer` globals. They may use `page`, their arguments, and ECMAScript
built-ins only. Method shorthand is fine; closures over the config file are not. Fixture data that
must reach a file input is written by the controller to `dataFile` (a `file` property in the
prepared data becomes that file's whole content).

**State accessors** are development-only (`import.meta.env.DEV`), read-only (SELECT-only database
access), bounded summaries — never raw rows, tokens or documents. The production smoke fails if a
`__harness` or `__e2eResetDb` global ships. On the production target `state` answers `unsupported`
instead of inventing an answer: assert visible UI or durable storage there.

## Sessions

```sh
web-harness preflight                    # Docker, pinned image, device, port — installs nothing
web-harness start [--target production] [--fixture NAME] [--browser B --device D] [--port P]
web-harness run FILE                     # batched (page, {step, assert, observe, state}) => …
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
- **Targets.** `dev` runs the project's dev server with the Vite identity plugin. `production`
  builds into the session directory (the checkout's `dist/` is untouched), records the build's
  content digest, and serves it with the Pages-style server.
- **Lifecycles are different operations.** `reload` keeps the page's storage and memory.
  `restart` closes the browser and reopens the same persistent profile: OPFS, IndexedDB,
  localStorage, caches and the service worker survive, memory does not — the proof a saved
  document survives a relaunch. Faults from the closed lifetime are retained. `reset` deletes the
  profile and replays the fixture; it refuses a changed fixture or setup digest.
- **Batches.** `run` executes trusted repository code in the session: a failed `step` or `assert`
  stops the batch, the screenshot and state are captured without masking the original error, and
  any retained fault fails an otherwise passing batch. Output over 16 KB is summarized; the full
  report stays on disk.

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
exercised. Fault checks run only on otherwise-passing tests, whose own failure is usually clearer.

## Production smoke

`web-harness smoke [--dist DIR]` serves the build and, in a fresh Chromium profile, checks in order:
required headers on `/`; a production bundle (no Vite client, no `/src/`); no development globals;
a service worker that controls the page after one reload; the project's `persist` action surviving
a reload; the same surviving an offline reload; and no faults throughout. It writes
`.web-harness/smoke/report.json` with the build digest.

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
- Emulated WebKit is not iOS Safari; installed-PWA behaviour, locked-phone timers and OS
  notification delivery need a real device — list them as `unsupported` scenarios.
- The static server does not run Pages Functions or `_redirects` (it refuses a build that has one).
- Batches, `--setup` files and fixture code are trusted repository code with full page access.

# Problem: web-harness memory requirements block browser workflows on a normal dev host

This describes a problem as observed. It does not propose a fix; the cause is
not confirmed.

## Summary

On a 12 GiB workstation with no swap, the harness's session memory check
refuses a live session because it wants about 6.5 GiB usable. `doctor` is where
the agent first sees the refusal; `start` uses the same check, so skipping
`doctor` does not unblock the browser workflow. The check says it counts only
3.2–4.5 GiB as usable, even when `free -h` reports about 8 GiB available at the
same moment. Agents that follow the web-harness skill are told not to use
`--force-resources`, so the live half of a UI audit never runs. They fall back
to reading code instead of observing the app, and spend turns and tokens
waiting for memory that never frees up.

## Where it happened

- **Host:** 12 GiB RAM, no swap, Linux (Arch).
- **Background load (usual for this machine):** a Hermes gateway (~370 MB) and
  dashboard (~330 MB), Docker, and interactive Claude Code / Codex sessions. A
  self-hosted Firecrawl stack (~3 GB) runs sometimes.
- **Task:** a Hermes Kanban card ran a "Workflow and Interaction Efficiency
  Audit" of `chess-mcp` using the web-harness skill (`pnpm exec web-harness`).
  Three Claude Code runs on 2026-09-28.

## What was observed

- **Requirement:** `doctor` reports needing **6.5 GiB: a 4.0 GiB session plus a
  2.5 GiB margin**, and cites the host having no swap.
- **Usable vs available:** across repeated `doctor` checks, it counted
  **3.2–4.5 GiB usable** (3.2–3.6 GiB in the first run). In the same runs,
  `free -h` showed **8.1–8.3 GiB available** (about 5.5 GiB of it buff/cache).
  No harness container was running, and nothing was listening on the dev port
  (4173).
- **Refusals:** `doctor` refused five times in the first run, and on every
  check in the later runs. The agent correctly declined `--force-resources`,
  as the skill instructs.
- **Waiting instead of working:** the agent wrote polling loops, including a
  shell loop on `/proc/meminfo` `MemAvailable` and a `wait-mem.mjs` script,
  waiting for about 6.8 GiB to free up. It never did.
- **Env overrides untested:** the agent tried
  `WEB_HARNESS_DOCKER_MEMORY=2g WEB_HARNESS_SERVER_HEAP_MB=768`, but those
  attempts were blocked for unrelated permission reasons. Their effect on a
  running session was not measured.

## Impact

- The live-session part of the audit never ran in three runs. All 21 findings
  in the resulting report are marked "code trace"; none was validated against
  the running app.
- The same host pressure can block `start` directly, `bench` (which starts a
  session), and container `e2e` (which has its own memory check). `smoke` runs a
  host browser without this check, so it can add pressure while another harness
  job runs. These are implementation paths, not additional observed refusals in
  the three audit runs.
- About $9 of Claude usage went into runs whose live-validation half could not
  start. Some of it went into memory polling instead of audit work.
- The agent workflow has no documented safe recovery from this refusal. It
  avoided `--force-resources` as instructed, then spent time polling instead of
  completing the browser audit.

## What the implementation used in the affected runs establishes

- Session `doctor`/`preflight` and `start` required the browser container's
  configured bound (3 GiB by default), the host server's configured V8 heap
  (1 GiB by default), and a margin (2.5 GiB without swap). Both environment
  overrides in the report reduce the requirement as well as the corresponding
  limits. The server heap is not a bound on its child processes.
- The budget reads `/proc/meminfo` `MemAvailable`, which includes reclaimable
  cache, then subtracts the unused capacity of running harness containers.
  Its refusal message reports both `available` and `reserved` and lists those
  containers. With no such containers at the check, `usable` equals
  `MemAvailable`. The historical 4 GiB-plus gap therefore needs the exact
  refusal output and a simultaneous host memory sample; the reported `free`
  readings alone cannot establish its cause.
- Container `e2e` required at least 3 GiB plus the same margin, then chose a
  container bound between 3 and 6 GiB from remaining usable memory. `smoke`
  uses a native browser and has no equivalent admission check or memory bound.
  Session manifests can record browser and server memory peaks, and `bench`
  collects them, but no peak measurement from the affected runs is in this
  report.

## Follow-up in this checkout

Two short `chess-mcp` sessions on 2026-09-29 peaked below 0.8 GiB in the browser
container and about 0.11 GiB in the server process tree. The session defaults
are now a 1.5 GiB browser bound, a 512 MiB server heap and a 2 GiB no-swap
margin, lowering the admission requirement from 6.5 to 4 GiB. An omitted
timezone or locale no longer fails startup, and a memory refusal happens
before the temporary browser probe with a concrete next step. A short live
session with the new defaults passed with zero faults. These measurements do
not establish a safe bound for every workflow, especially container `e2e` and
native `smoke`.

## Open questions for whoever fixes it

1. **Where the gap comes from:** what were `available`, `reserved`, and the
   listed containers in the exact refusal output, alongside a simultaneous
   `free -h` reading? Reclaimable cache is already included by `MemAvailable`;
   the agent's cache hypothesis does not explain the current code.
2. **The 4.0 GiB session figure:** is it what a session actually uses (browser,
   dev server, container), or a conservative bound? What does a real session
   peak at?
3. **The 2.5 GiB margin:** what measurements justify this fixed no-swap margin
   on a 12 GiB machine, and should it vary with the host or workload?
4. **Whole-harness safety:** should session `start`, container `e2e`, and native
   `smoke` coordinate admission so one cannot exhaust the other's headroom?
   How should host server child processes be accounted for?
5. **Guidance on refusal:** when memory really is short, what should the tool
   tell an agent to do, so it stops instead of polling?

## Desired outcome

Browser workflows start on a 12 GiB, no-swap workstation carrying its normal
background load, with no override flag. Or, if one genuinely cannot, every
harness entry point explains the same host budget with numbers that match the
OS at the time of the check and gives an actionable next step instead of a
check that never passes.

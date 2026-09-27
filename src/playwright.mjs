import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { A11Y_BOUNDARY, a11yConfig, axeLoaderSource, axeSource, classifyA11y, runAxe } from "./a11y.mjs";
import { applyFixture } from "./browser.mjs";
import { applyClock, clockHelper } from "./clock.mjs";
import { environmentConfig, evidenceConfig, findRoot } from "./config.mjs";
import { resolvePath } from "./core.mjs";
import { checkExpectation, diffValues, readWatched, settle, stableObservation } from "./effect.mjs";
import { toJsonl } from "./evidence.mjs";
import { failures, faultPolicy, unmetExpectations } from "./faults.mjs";
import { observe, readState } from "./inspect.mjs";
import { watchContext } from "./watch.mjs";

// The fault guard every Playwright suite shares with the controller. Pass the suite's own `test`
// (so there is exactly one Playwright instance) and the project's harness config.
//
//   import { test as base } from 'playwright/test'
//   import harness from '../../harness.config.mjs'
//   export const test = createHarnessTest(base, harness)
//
// Fixtures added:
//   pageFaultGuard   auto — watches the test's context; fails a passing test on any fault
//   watchContext     wire a context the test built itself (browser.newContext())
//   allowPageFaults  excuse faults this test causes on purpose (any kind; this test only)
//   expectPageFault  like allow, but the fault MUST occur: a failure path that never fired fails
//   checkA11y        scan the test's page with axe-core (harness.a11y); findings are faults of
//                    kind "a11y" judged with the rest at the end of the test
//
// A failing test gets network.jsonl and console.jsonl attached (every request and console line
// of its context, bounded and redacted), next to Playwright's own trace, screenshot and video.
export function createHarnessTest(base, harness = {}) {
  const policy = faultPolicy(harness.faults);
  const evidence = evidenceConfig(harness.evidence);
  return base.extend({
    pageFaultGuard: [
      async ({ context, baseURL }, use, testInfo) => {
        const records = [];
        const allowed = [];
        const expected = [];
        const origin = baseURL ? new URL(baseURL).origin : null;
        const record = (kind, detail) => records.push({ kind, detail });
        const guard = {
          watch: (target) =>
            watchContext(target, { policy, origin, record, initScript: harness.initScript, evidence }),
          allow(patterns) {
            allowed.push(...patterns);
          },
          expect(kind, pattern) {
            expected.push({ kind, pattern: pattern instanceof RegExp ? pattern.source : pattern });
            allowed.push(pattern);
          },
          add: (items) => records.push(...items),
          records: () => [...records],
          // Filtered on read, so a test may declare an allowance after the fault has arrived.
          faults: () => failures(records, policy, allowed),
        };

        const rings = await guard.watch(context);
        await use(guard);

        const attachEvidence = async () => {
          for (const [name, ring] of [["network.jsonl", rings.requests], ["console.jsonl", rings.console]])
            await testInfo.attach(name, { body: toJsonl(ring.entries), contentType: "application/x-ndjson" });
        };
        if (testInfo.status !== testInfo.expectedStatus) await attachEvidence();
        // Only assert on an otherwise-passing test: a page error is usually the cause of a
        // failure that already carries a clearer message.
        if (testInfo.status === "passed") {
          const remaining = guard.faults();
          const unmet = unmetExpectations(records, expected);
          if (remaining.length || unmet.length) {
            await attachEvidence();
            throw new Error(
              [
                ...remaining.map((fault) => `${fault.kind} — ${fault.detail}`),
                ...unmet.map(
                  (item) => `expected ${item.kind ?? "fault"} matching /${item.pattern}/ never occurred`,
                ),
              ].join("\n"),
            );
          }
        }
      },
      { auto: true },
    ],
    watchContext: async ({ pageFaultGuard }, use) => {
      await use((target) => pageFaultGuard.watch(target));
    },
    allowPageFaults: async ({ pageFaultGuard }, use) => {
      await use((...patterns) => pageFaultGuard.allow(patterns));
    },
    expectPageFault: async ({ pageFaultGuard }, use) => {
      await use((kind, pattern) => pageFaultGuard.expect(kind, pattern));
    },
    checkA11y: async ({ page, pageFaultGuard }, use) => {
      await use(async (overrides = {}) => {
        const scan = await scanA11y(page, harness, overrides);
        pageFaultGuard.add(scan.faults);
        return scan;
      });
    },
  });
}

// An axe-core scan of the page as it is now, classified like `check --a11y`: violations at or
// above `impact` are `a11y` fault records (a disabled rule's are kept, marked excused), lower ones
// warnings. Needs axe-core installed in the project.
export async function scanA11y(page, harness = {}, overrides = {}) {
  const settings = a11yConfig(harness.a11y ?? {}, overrides);
  const source = await axeSource(overrides.root ?? (await findRoot()));
  const loadAxe = new Function(`return (${axeLoaderSource(source)})`)();
  return { ...classifyA11y(await runAxe(page, settings, loadAxe), settings), settings, boundary: A11Y_BOUNDARY };
}

// A session's fixture in a test: the adapter's `prepare` in Node, then its `apply` through the
// page — the path the controller takes at `start` — with the environment's clock pinned first. So
// tests and sessions seed the same way instead of each keeping its own seeding code.
export async function applyHarnessFixture(page, harness, name, { url = "/", options = {}, root } = {}) {
  const fixtures = harness.fixtures ?? { blank: {} };
  const fixtureName = name ?? harness.defaultFixture ?? Object.keys(fixtures)[0];
  const fixture = fixtures[fixtureName];
  if (!fixture)
    throw new Error(`Unknown fixture ${fixtureName}. Registered: ${Object.keys(fixtures).join(", ")}.`);
  const projectRoot = root ?? (await findRoot());
  const data = fixture.prepare
    ? await fixture.prepare({ root: projectRoot, options, resolve: (value) => resolvePath(projectRoot, value) })
    : null;
  let dataFile = null;
  if (fixture.apply) {
    dataFile = path.join(await mkdtemp(path.join(os.tmpdir(), "wh-fixture-")), "fixture-data.json");
    await writeFile(dataFile, JSON.stringify(data?.file ?? data ?? null, null, 2));
  }
  const environment = environmentConfig(harness.environment);
  if (environment.clock !== "real") await applyClock(page, environment);
  return applyFixture(page, { url, data, dataFile }, { ready: harness.ready, apply: fixture.apply });
}

// What a batch receives, for the same function running as a test (see `web-harness promote`):
// step → test.step, assert → expect(…).toBeTruthy(), faults → allowPageFaults/expectPageFault, and
// observe, state, effect and clock with the batch's behaviour.
export function batchHelpers(page, harness, { test, expect, allowPageFaults, expectPageFault, target = "dev" } = {}) {
  const spec = {
    sections: harness.state?.sections ?? [],
    defaults: harness.state?.defaults ?? [],
    target,
    read: harness.state?.read ?? null,
  };
  const lib = { observe, readState, stateSpec: spec, durable: harness.durable?.read ?? null, stableObservation };
  const step = (name, action) => (test ? test.step(name, action) : action());
  const assert = (condition, message = "Assertion failed") => {
    if (expect) expect(condition, message).toBeTruthy();
    else if (!condition) throw new Error(message);
  };
  const effects = [];
  const effect = async (name, action, watch = {}) => {
    const mark = page.context().__webHarnessEvidence?.seq ?? 0;
    const before = await readWatched(page, watch, lib);
    const value = await step(name, action);
    const settled = watch.settle ? (await watch.settle(page), true) : await settle(page, mark, 5000);
    const after = await readWatched(page, watch, lib);
    const diff = diffValues(before.values, after.values, { entries: 50, value: 200 });
    effects.push({ name, settled, ...diff, unsupported: [...new Set([...before.unsupported, ...after.unsupported])] });
    const problem = checkExpectation(name, watch.expect, diff, before, after);
    if (problem) throw new Error(problem);
    return value;
  };
  const toSource = (pattern) => (pattern instanceof RegExp ? pattern.source : String(pattern));
  return {
    step,
    assert,
    observe: (selector, options) => observe(page, selector, options),
    state: (sections) => readState(page, sections, spec),
    effect,
    effects,
    allowFault: (pattern) => allowPageFaults?.(toSource(pattern)),
    expectFault: (kind, pattern) => expectPageFault?.(kind ?? null, toSource(pattern)),
    clock: clockHelper(page, environmentConfig(harness.environment).clock),
  };
}

// Shared Playwright config fields, so every suite keeps the same evidence of a failure: the trace
// of the attempt that FAILED (not only of its retry), a screenshot and video, one retry that must
// not turn a flaky test green, and no focused-only runs in CI. Spread into defineConfig:
//
//   export default defineConfig({ ...harnessPlaywright(harness), testDir: 'tests/e2e', webServer })
export function harnessPlaywright(harness = {}, overrides = {}) {
  const ci = Boolean(process.env.CI);
  // The harness environment's timezone and locale; `web-harness e2e --timezone/--locale` (through
  // WEB_HARNESS_TIMEZONE/LOCALE) runs the same suite in another one.
  const environment = environmentConfig(harness.environment, {
    timezoneId: process.env.WEB_HARNESS_TIMEZONE || undefined,
    locale: process.env.WEB_HARNESS_LOCALE || undefined,
  });
  return {
    forbidOnly: ci,
    retries: ci ? 1 : 0,
    failOnFlakyTests: ci,
    reporter: [["list"], ["html", { open: "never" }]],
    ...overrides,
    use: {
      ...(environment.timezoneId ? { timezoneId: environment.timezoneId } : {}),
      ...(environment.locale ? { locale: environment.locale } : {}),
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
      ...overrides.use,
    },
  };
}

// Playwright `webServer` for the production target: build, then serve the output exactly as the
// Pages host would (public/_headers applied, SPA fallback). Never reuses a server that is already
// listening — a leftover preview from an earlier build would otherwise be tested silently.
// `WEB_HARNESS_PREBUILT=1` (CI, with the checks job's artifact already in place) skips the build
// so the suite tests the very bytes that ship.
export function productionServer({ port, build, dist = "dist", unserved = [], timeout = 180_000 }) {
  const serve = [
    "node",
    JSON.stringify(new URL("../bin/web-harness.mjs", import.meta.url).pathname),
    "serve",
    "--dir",
    JSON.stringify(dist),
    "--port",
    String(port),
    ...unserved.flatMap((prefix) => ["--unserved", JSON.stringify(prefix)]),
  ].join(" ");
  return {
    command: process.env.WEB_HARNESS_PREBUILT === "1" ? serve : `${build} && ${serve}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout,
  };
}

// Development-target server for suites that need dev-only accessors. Same no-reuse rule.
export function devServer({ command, port, timeout = 120_000 }) {
  return {
    command,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout,
  };
}

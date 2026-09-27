import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findRoot, functionSource, loadConfig, validateConfig } from "../src/config.mjs";
import { decide } from "../.github/actions/verdict/verdict.mjs";
import { flattenResults, titleMatcher, validateScenarios } from "../src/scenarios.mjs";

const minimal = {
  name: "demo",
  dev: { command: (port) => ["pnpm", "exec", "vite", "--port", String(port), "--strictPort"] },
};

test("function sources: arrows and functions pass, method shorthand is rewritten, others fail", () => {
  assert.equal(functionSource(async (page) => page, "x"), "async (page) => page");
  const methods = {
    async ready(page) {
      return page;
    },
    plain(a) {
      return a;
    },
  };
  assert.match(functionSource(methods.ready, "ready"), /^async function ready\(page\)/);
  assert.match(functionSource(methods.plain, "plain"), /^function plain\(a\)/);
  assert.throws(() => functionSource("() => 1", "x"), /must be a function/);
  // A native function has no source to ship.
  assert.throws(() => functionSource(Math.max, "x"), /standalone/);
});

test("config validation fills defaults and rejects what cannot work", () => {
  const config = validateConfig(minimal, "/repo");
  assert.equal(config.port, 4173);
  assert.equal(config.defaultFixture, "blank");
  assert.equal(config.policy.external, "fault");
  assert.deepEqual(config.defaults, { browser: "chromium", device: "Desktop Chrome" });
  assert.throws(() => validateConfig({ ...minimal, name: "Bad Name" }, "/repo"), /name/);
  assert.throws(() => validateConfig({ name: "demo" }, "/repo"), /dev.command/);
  assert.throws(
    () => validateConfig({ ...minimal, dev: { command: () => "vite" } }, "/repo"),
    /array of strings/,
  );
  assert.throws(
    () => validateConfig({ ...minimal, production: { build: () => [] } }, "/repo"),
    /non-empty/,
  );
  assert.throws(
    () => validateConfig({ ...minimal, fixtures: { a: {} }, defaultFixture: "b" }, "/repo"),
    /not registered/,
  );
  assert.throws(
    () => validateConfig({ ...minimal, state: { sections: ["a"], defaults: ["b"] } }, "/repo"),
    /registered sections/,
  );
  assert.throws(() => validateConfig({ ...minimal, port: 80 }, "/repo"), /port/);
});

test("the project root is the nearest harness.config.mjs; the package manager follows the lockfile", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-config-"));
  try {
    await mkdir(path.join(directory, "apps/ui"), { recursive: true });
    await writeFile(
      path.join(directory, "harness.config.mjs"),
      `export default { name: "demo", dev: { command: (port) => ["vite", "--port", String(port)] } };`,
    );
    await writeFile(path.join(directory, "package-lock.json"), "{}");
    assert.equal(await findRoot(path.join(directory, "apps/ui")), directory);
    const config = await loadConfig(path.join(directory, "apps/ui"));
    assert.equal(config.packageManager, "npm");
    await assert.rejects(findRoot(os.tmpdir()), /No harness.config.mjs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verdict: failures, cancellations and required jobs that did not run all fail", () => {
  const ok = (result) => ({ result });
  assert.equal(decide({ scope: ok("success"), checks: ok("success") }, "true", ["checks"]).ok, true);
  assert.equal(decide({ scope: ok("success"), checks: ok("skipped") }, "false", ["checks"]).ok, true);
  assert.equal(decide({ scope: ok("success"), checks: ok("skipped") }, "true", ["checks"]).ok, false);
  assert.equal(decide({ scope: ok("success"), e2e: ok("failure") }, "false", []).ok, false);
  assert.equal(decide({ scope: ok("success"), e2e: ok("cancelled") }, "true", []).ok, false);
  assert.equal(decide({ scope: ok("failure") }, "", []).ok, false);
  assert.equal(decide({ scope: ok("success") }, "true", ["smoke"]).ok, false);
});

test("scenario inventory: every scenario is covered or says why not", () => {
  assert.throws(() => validateScenarios([{ id: "a", title: "A" }]), /covers no test/);
  assert.throws(
    () => validateScenarios([{ id: "a", title: "A", status: "unsupported" }]),
    /needs a reason/,
  );
  assert.throws(
    () =>
      validateScenarios([
        { id: "a", title: "A", status: "not-run", reason: "r" },
        { id: "a", title: "B", status: "not-run", reason: "r" },
      ]),
    /Duplicate/,
  );
  const rows = flattenResults(
    {
      suites: [
        {
          file: "workout.spec.ts",
          specs: [
            {
              title: "finishes",
              file: "workout.spec.ts",
              tests: [{ projectName: "chromium", status: "expected" }],
            },
          ],
          suites: [
            {
              title: "nested",
              specs: [{ title: "inner", tests: [{ projectName: "chromium", status: "unexpected" }] }],
            },
          ],
        },
      ],
    },
    "tests/e2e",
  );
  assert.deepEqual(rows, [
    { file: "tests/e2e/workout.spec.ts", title: "finishes", project: "chromium", outcome: "expected" },
    { file: "tests/e2e/workout.spec.ts", title: "inner", project: "chromium", outcome: "unexpected" },
  ]);
});

test("scenario titles: exact by default, every expansion of a template literal", () => {
  const exact = titleMatcher("logs a set (week 1)");
  assert.equal(exact("logs a set (week 1)"), true);
  assert.equal(exact("logs a set (week 2)"), false);
  const template = titleMatcher("${route} shows the party (${theme})");
  assert.equal(template("/rewards shows the party (cozy)"), true);
  assert.equal(template("shows the party (cozy)"), false);
  assert.equal(template("/ shows the party [cozy]"), false);
});

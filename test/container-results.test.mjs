import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { rehomeResults } from "../src/container.mjs";

const bin = fileURLToPath(new URL("../bin/web-harness.mjs", import.meta.url));
const scenarios = (cwd, results) =>
  new Promise((resolve) =>
    execFile(process.execPath, [bin, "scenarios", "--results", results], { cwd }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, out: stdout + stderr }),
    ),
  );

// A Playwright JSON report as the container writes it: every path under /work, and a test whose
// title is a template literal expanded per route. This is the shape that made chorequest's CI
// report "did not run" for 39 tests that had just passed.
const containerReport = () => ({
  config: {
    rootDir: "/work/tests/e2e",
    configFile: "/work/playwright.config.ts",
    projects: [{ name: "phone", testDir: "/work/tests/e2e", outputDir: "/work/test-results" }],
  },
  suites: [
    {
      file: "party-ui.spec.ts",
      suites: [
        {
          title: "dungeon",
          specs: ["/", "/rewards"].map((route) => ({
            title: `${route} shows the complete party without overflow`,
            file: "party-ui.spec.ts",
            tests: [{ projectName: "phone", status: "expected" }],
          })),
        },
      ],
    },
  ],
});

test("container results are rehomed onto the checkout, and the scenario join then finds them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wh-rehome-"));
  try {
    await mkdir(path.join(root, "tests/e2e"), { recursive: true });
    await writeFile(
      path.join(root, "harness.config.mjs"),
      `export default { name: "demo", dev: { command: (port) => ["vite", "--port", String(port)] },
        scenarios: [{ id: "party", title: "Party", covers: [
          { file: "tests/e2e/party-ui.spec.ts", test: "\${route} shows the complete party without overflow" } ] }] };`,
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "");
    await writeFile(
      path.join(root, "tests/e2e/party-ui.spec.ts"),
      "for (const route of ['/', '/rewards']) test(`${route} shows the complete party without overflow`, () => {})\n",
    );

    // As CI had it: container paths straight through — the join cannot match.
    await writeFile(path.join(root, "raw.json"), JSON.stringify(containerReport()));
    const raw = await scenarios(root, "raw.json");
    assert.equal(raw.code, 1, raw.out);
    assert.match(raw.out, /did not run/);

    // Rehomed as the runner now writes it: verified.
    const rehomed = rehomeResults(containerReport(), root);
    assert.equal(rehomed.config.rootDir, path.join(root, "tests/e2e"));
    assert.equal(rehomed.config.projects[0].outputDir, path.join(root, "test-results"));
    await writeFile(path.join(root, "rehomed.json"), JSON.stringify(rehomed));
    const fixed = await scenarios(root, "rehomed.json");
    assert.equal(fixed.code, 0, fixed.out);
    assert.match(fixed.out, /verified\s+party/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rehoming leaves host paths and a missing config alone", () => {
  const host = { config: { rootDir: "/home/me/app/tests/e2e", configFile: "/workshop/x.ts" } };
  assert.deepEqual(rehomeResults(structuredClone(host), "/elsewhere"), host);
  assert.deepEqual(rehomeResults({ suites: [] }, "/r"), { suites: [] });
});

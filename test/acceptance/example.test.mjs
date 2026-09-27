import assert from "node:assert/strict";
import { access, cp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { dockerIds, exec, lastJson, prepareExample } from "./example.mjs";

// Real sessions, a real smoke and a real container E2E run against examples/minimal. Heavy: one
// session container (3 GiB bound) at a time, and the E2E container alone. Run with
// `pnpm test:acceptance` (serial), never beside other browser or container work.

let example;
const exists = (file) => access(file).then(() => true, () => false);
const leaseFile = (port) => path.join(os.tmpdir(), `web-harness-${process.getuid()}-port-${port}.lock`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  example = await prepareExample();
});

after(async () => {
  for (const session of ["accept", "prod", "interrupt"])
    await example?.harness(["--session", session, "stop"]).catch(() => {});
  await example?.cleanup();
});

test("controller: a session's whole lifecycle, and the refusals that keep it owned", { timeout: 20 * 60_000 }, async (t) => {
  const { harness, readJson, root } = example;
  const session = (args) => harness(["--session", "accept", ...args]);
  const manifest = () => readJson(".web-harness/accept/session.json");

  await t.test("preflight launches the pinned image and reports the memory budget", async () => {
    const result = await harness(["preflight"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.match(report.imageId, /^sha256:/);
    assert.equal(typeof report.resources.ok, "boolean");
  });

  await t.test("start seeds the fixture through the UI and records zero faults", async () => {
    const result = await session(["start", "--fixture", "saved"]);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-3000));
    const current = await manifest();
    assert.equal(current.status, "ready");
    assert.equal(current.postconditions.applied.saved, "first note");
    assert.ok(await exists(path.join(current.runDir, "00-seeded.yml")));
    const faults = JSON.parse(await readFile(path.join(current.runDir, "faults.json"), "utf8"));
    assert.deepEqual(faults.faults, []);
  });

  await t.test("a passing batch returns its steps and result as JSON", async () => {
    const result = await session(["run", "batches/save.js"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.steps.map((step) => step.name), ["type and save", "read back"]);
    assert.equal(report.result.note.text, "from a batch");
  });

  await t.test("restart reopens the same profile: the saved note survives", async () => {
    const result = await session(["restart"]);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-2000));
    const state = lastJson((await session(["state"])).stdout);
    assert.equal(state.result.note.text, "from a batch");
  });

  await t.test("a batch that faults fails, keeping the original error and its evidence", async () => {
    const result = await session(["run", "batches/break.js"]);
    assert.equal(result.code, 1);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, false);
    assert.match(report.error, /retained browser fault/);
    assert.ok(await exists(report.artifacts.screenshot), "failure screenshot");
    assert.ok(await exists(report.faultsReport), "faults.json");
  });

  await t.test("faults from before a restart are retained, not laundered", async () => {
    const result = await session(["restart"]);
    assert.equal(result.code, 1, "the retained faults fail the restart's check");
    const faults = JSON.parse(await readFile(path.join((await manifest()).runDir, "faults.json"), "utf8"));
    assert.ok(faults.faults.some((fault) => /induced failure/.test(fault.detail)), JSON.stringify(faults.faults));
  });

  await t.test("reset replays the fixture on a new profile and a new run directory", async () => {
    const before = await manifest();
    const result = await session(["reset"]);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-2000));
    const current = await manifest();
    assert.notEqual(current.runId, before.runId);
    const state = lastJson((await session(["state"])).stdout);
    assert.deepEqual(state.result.note, { text: "first note", revision: 1 });
  });

  await t.test("reset refuses a fixture that changed since start", async () => {
    const config = path.join(root, "harness.config.mjs");
    const original = await readFile(config, "utf8");
    try {
      await writeFile(config, original.replace('text: "first note"', 'text: "an edited note"'));
      const result = await session(["reset"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Fixture\/setup changed/);
    } finally {
      await writeFile(config, original);
    }
  });

  await t.test("a second session cannot take the running session's port", async () => {
    const result = await harness(["--session", "intruder", "start"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /occupied|reserved/);
    assert.deepEqual(await dockerIds("label=web-harness.session=intruder"), []);
  });

  await t.test("a foreign server on the port is refused and never signalled", async () => {
    const foreign = http.createServer((_request, response) => response.end("foreign"));
    await new Promise((resolve) => foreign.listen(4194, "127.0.0.1", resolve));
    try {
      const owned = await harness(["--session", "foreign", "start", "--port", "4194"]);
      assert.equal(owned.code, 1);
      assert.match(owned.stderr, /occupied/);
      const attached = await harness(["--session", "foreign", "start", "--url", "http://127.0.0.1:4194"]);
      assert.equal(attached.code, 1);
      assert.match(attached.stderr, /No example development server/);
      assert.equal(await (await fetch("http://127.0.0.1:4194/")).text(), "foreign");
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  });

  await t.test("a manifest pointed at someone else's container cannot make stop remove it", async () => {
    const current = await manifest();
    // Same image, same root label, another session's token: everything but ownership matches.
    const { stdout } = await exec("docker", [
      "create",
      "--label",
      `web-harness.root=${root}`,
      "--label",
      "web-harness.token=someone-else",
      current.imageId,
      "sleep",
      "infinity",
    ]);
    const decoy = stdout.trim();
    const file = path.join(root, ".web-harness/accept/session.json");
    try {
      await writeFile(file, JSON.stringify({ ...current, containerId: decoy }, null, 2));
      const result = await session(["stop"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr + result.stdout, /Container ownership mismatch/);
      assert.deepEqual(await dockerIds(`id=${decoy}`), [decoy], "the decoy survived");
    } finally {
      const after = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...after, containerId: current.containerId }, null, 2));
      await exec("docker", ["rm", "--force", decoy]);
    }
  });

  await t.test("stop removes exactly what the session owned", async () => {
    const { server } = await manifest();
    const result = await session(["stop"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await manifest()).status, "stopped");
    assert.deepEqual(await dockerIds(`label=web-harness.root=${root}`), []);
    assert.equal(await exists(leaseFile(4191)), false);
    assert.equal(alive(server.pid), false);
  });

  await t.test("a production session serves the build it digested and has no dev accessor", async () => {
    const prod = (args) => harness(["--session", "prod", ...args]);
    const started = await prod(["start", "--target", "production", "--port", "4195", "--fixture", "blank"]);
    assert.equal(started.code, 0, started.stderr + started.stdout.slice(-2000));
    const current = await readJson(".web-harness/prod/session.json");
    assert.match(current.build.digest, /^[0-9a-f]{64}$/);
    const state = lastJson((await prod(["state"])).stdout);
    assert.match(state.result.unsupported, /Production builds carry no development accessors/);
    assert.equal((await prod(["stop"])).code, 0);
    assert.deepEqual(await dockerIds(`label=web-harness.root=${root}`), []);
  });

  await t.test("an interrupted start cleans up everything it had created", async () => {
    const child = example.spawnHarness(["--session", "interrupt", "start", "--port", "4196"]);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise((resolve) => child.once("close", resolve));
    const deadline = Date.now() + 180_000;
    while (!(await dockerIds("label=web-harness.session=interrupt")).length) {
      assert.ok(Date.now() < deadline, `container never appeared:\n${output.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.kill("SIGINT");
    assert.notEqual(await exited, 0);
    assert.deepEqual(await dockerIds("label=web-harness.session=interrupt"), []);
    assert.equal(await exists(leaseFile(4196)), false);
    assert.equal((await readJson(".web-harness/interrupt/session.json")).status, "stopped");
  });
});

test("smoke: passes the example build, and fails each broken variant in the right phase", { timeout: 10 * 60_000 }, async (t) => {
  const { harness, root } = example;
  const build = await exec("npx", ["--no-install", "vite", "build"], { cwd: root });
  assert.equal(build.code, 0, build.stderr);

  const smoke = async (dist, name) => {
    const output = `.web-harness/smoke-${name}`;
    const result = await harness(["smoke", "--dist", dist, "--output", output]);
    return { ...result, report: JSON.parse(await readFile(path.join(root, output, "report.json"), "utf8")) };
  };
  const variant = async (name, change) => {
    const dist = path.join(root, `dist-${name}`);
    await rm(dist, { recursive: true, force: true });
    await cp(path.join(root, "dist"), dist, { recursive: true });
    await change(dist);
    return `dist-${name}`;
  };
  const failedPhase = (report) => report.checks.find((check) => !check.ok)?.name;

  await t.test("the real build passes every phase", async () => {
    const { code, report } = await smoke("dist", "ok");
    assert.equal(code, 0, JSON.stringify(report.checks));
    assert.deepEqual(report.checks.map((check) => check.name), ["headers", "bundle", "globals", "sw", "persist", "offline", "faults"]);
  });

  await t.test("a missing required header fails headers", async () => {
    const dist = await variant("headers", async (dir) => {
      const file = path.join(dir, "_headers");
      await writeFile(file, (await readFile(file, "utf8")).replace(/^\s*X-Content-Type-Options.*$/m, ""));
    });
    const { code, report } = await smoke(dist, "headers");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "http");
    assert.match(report.error, /x-content-type-options/);
  });

  await t.test("a development accessor in the bundle fails globals", async () => {
    const dist = await variant("globals", async (dir) => {
      await writeFile(path.join(dir, "leak.js"), "window.__harness = {};\n");
      const index = path.join(dir, "index.html");
      await writeFile(index, (await readFile(index, "utf8")).replace("</head>", '<script src="/leak.js"></script></head>'));
    });
    const { code, report } = await smoke(dist, "globals");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "load");
    assert.match(report.error, /Development globals in production: __harness/);
  });

  await t.test("a missing service worker fails sw", async () => {
    const dist = await variant("sw", (dir) => rm(path.join(dir, "sw.js")));
    const { code, report } = await smoke(dist, "sw");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "sw");
  });
});

test("e2e: the suite runs in the pinned container and the scenario join verifies it", { timeout: 20 * 60_000 }, async () => {
  const { harness, readJson, root } = example;
  const run = await harness(["e2e"]);
  assert.equal(run.code, 0, run.stderr + run.stdout.slice(-4000));
  const results = await readJson("e2e-results.json");
  assert.ok(results.config.rootDir.startsWith(root), `not rehomed: ${results.config.rootDir}`);
  const scenarios = await harness(["scenarios", "--results", "e2e-results.json"]);
  assert.equal(scenarios.code, 0, scenarios.stderr + scenarios.stdout);
  assert.match(scenarios.stdout, /verified\s+save-note/);
  assert.match(scenarios.stdout, /unsupported\s+installed-phone/);
});

import assert from "node:assert/strict";
import { access, cp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
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
  for (const session of ["accept", "prod", "interrupt", "env", "clock"])
    await example?.harness(["--session", session, "stop"]).catch(() => {});
  await example?.cleanup();
});

test("controller: a session's whole lifecycle, and the refusals that keep it owned", { timeout: 20 * 60_000 }, async (t) => {
  const { harness, readJson, root } = example;
  const session = (args, options) => harness(["--session", "accept", ...args], options);
  const manifest = () => readJson(".web-harness/accept/session.json");

  await t.test("preflight launches the pinned image and reports the memory budget", async () => {
    const result = await harness(["preflight"]);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
    assert.match(report.imageId, /^sha256:/);
    assert.equal(typeof report.resources.ok, "boolean");
    assert.equal(report.evidenceIgnored, true, "the example ignores .web-harness/");
  });

  await t.test("describe prints what an agent needs, and doctor notices a stale skill", async () => {
    const described = await harness(["describe", "--json"]);
    assert.equal(described.code, 0, described.stderr);
    const project = JSON.parse(described.stdout);
    assert.deepEqual(project.fixtures.map((fixture) => fixture.name), ["saved", "imported", "blank"]);
    assert.equal(project.fixtures[0].default, true);
    assert.deepEqual(project.targets, ["dev", "production"]);
    assert.equal(project.a11y.impact, "serious");
    assert.equal(project.e2e.fixtures, "tests/e2e/fixtures.js");
    assert.ok(project.commands.session.includes("describe"));
    assert.ok(project.commands.tools.includes("promote"));
    assert.deepEqual(project.smoke.hooks, ["ready", "persist", "verify", "update.prompt", "update.accept", "update.dismiss"]);
    assert.equal(project.scenarios.find((scenario) => scenario.id === "installed-phone").status, "unsupported");

    const installed = await harness(["skill", "install", "--dir", ".claude/skills"]);
    assert.equal(installed.code, 0, installed.stderr);
    const skillFile = path.join(root, ".claude/skills/web-harness/SKILL.md");
    const skill = await readFile(skillFile, "utf8");
    assert.match(skill, /^---\nname: web-harness\n/);
    const fresh = await harness(["doctor"]);
    assert.doesNotMatch(fresh.stderr, /SKILL\.md/);
    await writeFile(skillFile, skill.replace(/<!-- web-harness \d+\.\d+\.\d+:/, "<!-- web-harness 0.0.1:"));
    const stale = await harness(["doctor"]);
    assert.match(stale.stderr, /warning: \.claude\/skills\/web-harness\/SKILL\.md is from web-harness 0\.0\.1/);
    await rm(path.join(root, ".claude"), { recursive: true, force: true });
  });

  await t.test("start seeds the fixture through the UI and records zero faults", async () => {
    // A credential in the developer's environment must not reach the owned server.
    const result = await session(["start", "--fixture", "saved"], {
      env: { ...process.env, ACCEPTANCE_SECRET_TOKEN: "must-not-leak" },
    });
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-3000));
    const current = await manifest();
    assert.equal(current.state, "ready");
    assert.equal(current.postconditions.applied.saved, "first note");
    assert.ok(await exists(path.join(current.runDir, "00-seeded.yml")));
    const faults = JSON.parse(await readFile(path.join(current.runDir, "faults.json"), "utf8"));
    assert.deepEqual(faults.faults, []);
    assert.equal(faults.status, "passed");
  });

  await t.test("the manifest is a valid v3 record of source, driver, environment and host", async () => {
    const current = await manifest();
    const { validateManifest } = await import(
      pathToFileURL(path.join(root, "node_modules/@azeajr/web-harness/src/manifest.mjs")).href
    );
    assert.deepEqual(validateManifest(current), []);
    assert.match(current.source.commit, /^[0-9a-f]{40}$/);
    assert.equal(current.driver.playwright, "1.63.0");
    assert.deepEqual(
      { timezoneId: current.environment.effective.timezoneId, locale: current.environment.effective.locale },
      { timezoneId: "UTC", locale: "en-US" },
    );
    for (const phase of ["preflight", "serverReady", "container", "initialize", "total"])
      assert.equal(typeof current.timings[phase], "number", phase);
    assert.equal(current.hostEnvironment.isolated, true);
    const environ = (await readFile(`/proc/${current.server.pid}/environ`, "utf8")).split("\0");
    assert.ok(environ.includes(`HOME=${current.hostEnvironment.home}`), "HOME is the session's");
    assert.ok(current.hostEnvironment.home.startsWith(path.join(root, ".web-harness/accept")));
    assert.ok(!environ.some((entry) => entry.startsWith("ACCEPTANCE_SECRET_TOKEN=")), "the credential stayed out");
  });

  await t.test("a passing batch returns its steps and result as JSON", async () => {
    const result = await session(["run", "batches/save.js"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.status, "passed");
    assert.deepEqual(report.steps.map((step) => step.name), ["type and save", "read back"]);
    assert.equal(report.result.note.text, "from a batch");
  });

  await t.test("restart reopens the same profile: the saved note survives", async () => {
    const result = await session(["restart"]);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-2000));
    const state = lastJson((await session(["state"])).stdout);
    assert.equal(state.result.note.text, "from a batch");
  });

  await t.test("effect passes a real change and a cancel, and fails the quiet no-op", async () => {
    const good = await session(["run", "batches/effects.js"]);
    const report = lastJson(good.stdout);
    assert.equal(good.code, 0, JSON.stringify(report));
    assert.deepEqual(report.effects.map((item) => item.name), ["save a note", "cancel the delete dialog"]);
    assert.ok(report.effects[0].changed.some((change) => change.path === "durable.note.text"), JSON.stringify(report.effects[0]));
    assert.equal(report.effects[1].changedCount, 0, JSON.stringify(report.effects[1]));
    const noop = await session(["run", "batches/noop.js"]);
    assert.equal(noop.code, 1);
    assert.match(lastJson(noop.stdout).error, /archive the note: no watched change/);
  });

  await t.test("the CLI form of effect diffs around one Playwright CLI action", async () => {
    const changed = await session([
      "effect", "--observe", "#saved", "--durable", "--until", '#saved:has-text("via the cli")', "--expect", "change",
      "--", "eval", "() => { document.getElementById('note').value = 'via the cli'; document.getElementById('save').click(); }",
    ]);
    const report = lastJson(changed.stdout);
    assert.equal(changed.code, 0, JSON.stringify(report));
    assert.ok(report.changed.some((change) => change.path === "durable.note.text" && /via the cli/.test(change.after)), JSON.stringify(report.changed));
    const still = await session(["effect", "--observe", "#saved", "--expect", "change", "--", "eval", "() => document.getElementById('archive').click()"]);
    assert.equal(still.code, 1);
    assert.match(lastJson(still.stdout).error, /no watched change/);
  });

  await t.test("a batch that expects its faults passes, and check no longer counts them", async () => {
    const result = await session(["run", "batches/expected-fault.js"]);
    const report = lastJson(result.stdout);
    assert.equal(result.code, 0, JSON.stringify(report));
    assert.ok(report.expectedFaults.length === 2 && report.expectedFaults.every((item) => item.met), JSON.stringify(report.expectedFaults));
    const checked = await session(["check"]);
    assert.equal(checked.code, 0, checked.stderr);
    const faults = JSON.parse(await readFile(path.join((await manifest()).runDir, "faults.json"), "utf8"));
    assert.ok(faults.records.some((record) => record.excusedBy && /induced failure/.test(record.detail)), "kept as evidence");
  });

  await t.test("after a batch whose outcome is unknown, runs wait for reconcile", async () => {
    const timedOut = await session(["run", "batches/slow.js"], {
      env: { ...process.env, WEB_HARNESS_CLI_TIMEOUT_MS: "3000" },
    });
    assert.equal(timedOut.code, 1);
    const report = lastJson(timedOut.stdout);
    assert.equal(report.outcome, "unknown");
    assert.equal(report.status, "infrastructure_failed");
    const refused = await session(["run", "batches/save.js"]);
    assert.equal(refused.code, 1);
    assert.match(lastJson(refused.stdout).error, /outcome of batch .* is unknown/);
    const reconciled = await session(["reconcile"]);
    assert.equal(reconciled.code, 0, reconciled.stdout + reconciled.stderr);
    const summary = lastJson(reconciled.stdout);
    assert.equal(summary.reconciled, report.batchId);
    assert.ok(await exists(path.join(summary.directory, "index.json")));
    assert.equal((await manifest()).pendingReconciliation, null);
    const again = await session(["run", "batches/save.js"]);
    assert.equal(again.code, 0, again.stdout);
  });

  await t.test("a batch that faults fails, keeping the original error and a full bundle", async () => {
    const result = await session(["run", "batches/break.js", "--trace", "retain-on-failure"]);
    assert.equal(result.code, 1);
    const report = lastJson(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, "failed");
    assert.match(report.error, /retained browser fault/);
    assert.ok(await exists(report.faultsReport), "faults.json");
    const bundle = report.summary.bundle;
    // The query token is redacted in every piece of evidence.
    assert.match(report.error + JSON.stringify(report.faults), /token=\[redacted\]/);
    for (const file of ["network.jsonl", "console.jsonl", "timeline.jsonl", "faults.json", "index.json", "storage.json"])
      assert.doesNotMatch(await readFile(path.join(bundle, file), "utf8"), /example-secret/, `${file} leaks the token`);
    for (const file of ["index.json", "network.jsonl", "console.jsonl", "aria.yml", "storage.json", "timeline.jsonl", "faults.json", "screenshot.png", "trace.zip"])
      assert.ok(await exists(path.join(bundle, file)), `bundle has ${file}`);
    const lines = async (file) => (await readFile(path.join(bundle, file), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.ok((await lines("network.jsonl")).some((request) => /missing\.json/.test(request.url) && request.status === 404));
    assert.ok((await lines("console.jsonl")).some((line) => line.text === "induced failure"));
    assert.ok((await lines("timeline.jsonl")).some((row) => row.source === "step" && row.name === "press Break"));
    const storage = JSON.parse(await readFile(path.join(bundle, "storage.json"), "utf8"));
    assert.ok(storage.indexedDB.some((database) => database.name === "notes"), JSON.stringify(storage.indexedDB));
    assert.match(await readFile(path.join(bundle, "aria.yml"), "utf8"), /Notes/);
    assert.match(report.summary.firstFault, /induced failure|missing\.json/);
    const index = JSON.parse(await readFile(path.join(bundle, "index.json"), "utf8"));
    assert.match(index.privateData, /trace\.zip/);
    // The same batch again is a second attempt, and says the first one failed.
    const again = lastJson((await session(["run", "batches/break.js"])).stdout);
    assert.equal(again.attempt, 2);
    assert.equal(again.priorAttempts[0].ok, false);
  });

  await t.test("faults from before a restart are retained, not laundered", async () => {
    const result = await session(["restart"]);
    assert.equal(result.code, 1, "the retained faults fail the restart's check");
    const bundle = /Failure bundle: (\S+)/.exec(result.stderr)?.[1];
    assert.ok(bundle && (await exists(path.join(bundle, "index.json"))), result.stderr.slice(-1000));
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

  await t.test("check --a11y fails an icon button without a name, and a disabled rule keeps the record", async () => {
    const clean = await session(["check", "--a11y"]);
    assert.equal(clean.code, 0, clean.stderr + clean.stdout.slice(-2000));
    const unlabel = await session(["cli", "eval", "() => document.getElementById('clear').removeAttribute('aria-label')"]);
    assert.equal(unlabel.code, 0, unlabel.stderr);
    const failed = await session(["check", "--a11y"]);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /a11y: button-name \(critical\)/);
    const { runDir } = await manifest();
    const faults = JSON.parse(await readFile(path.join(runDir, "faults.json"), "utf8"));
    assert.equal(faults.a11y.faults, 1);
    assert.match(faults.a11y.boundary, /not an audit/);
    const excused = await session(["check", "--a11y", "--a11y-disable", "button-name"]);
    assert.equal(excused.code, 0, excused.stderr);
    const kept = JSON.parse(await readFile(path.join(runDir, "faults.json"), "utf8"));
    assert.equal(kept.records.find((record) => record.rule === "button-name")?.excusedBy, "a11y.disable");
    // A scan is of the page as it is: a plain check afterwards does not carry it.
    assert.equal((await session(["reload"])).code, 0);
    assert.equal((await session(["check"])).code, 0);
  });

  await t.test("stop removes exactly what the session owned", async () => {
    const { server, hostEnvironment } = await manifest();
    const result = await session(["stop"]);
    assert.equal(result.code, 0, result.stderr);
    const stopped = await manifest();
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.cleanup.status, "passed");
    assert.ok(stopped.artifacts.some((artifact) => artifact.path === "00-seeded.yml" && artifact.kind === "aria"));
    const { validateManifest } = await import(
      pathToFileURL(path.join(root, "node_modules/@azeajr/web-harness/src/manifest.mjs")).href
    );
    assert.deepEqual(validateManifest(stopped), []);
    assert.equal(await exists(hostEnvironment.home), false, "the session's HOME is removed");
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
    assert.equal((await readJson(".web-harness/interrupt/session.json")).state, "stopped");
  });

  await t.test("a session's timezone, locale and pinned clock hold across a restart", async () => {
    const env = (args) => harness(["--session", "env", ...args]);
    const started = await env([
      "start", "--port", "4197", "--fixture", "blank",
      "--timezone", "Pacific/Kiritimati", "--locale", "en-GB", "--clock", "fixed", "--now", "2026-03-08T06:59:00Z",
    ]);
    assert.equal(started.code, 0, started.stderr + started.stdout.slice(-2000));
    const current = await readJson(".web-harness/env/session.json");
    assert.equal(current.environment.effective.timezoneId, "Pacific/Kiritimati");
    assert.equal(current.environment.effective.locale, "en-GB");
    assert.match(current.environment.effective.now, /^2026-03-08T06:59:00/);
    assert.equal((await env(["restart"])).code, 0);
    const probe = await env(["cli", "eval", "() => Intl.DateTimeFormat().resolvedOptions().timeZone + '|' + new Date().toISOString()"]);
    assert.match(probe.stdout, /Pacific\/Kiritimati\|2026-03-08T06:59:00/, probe.stdout.slice(-1000));
    assert.equal((await env(["stop"])).code, 0);
  });

  await t.test("an installed clock survives a restart and moves only when a batch moves it", async () => {
    const clock = (args) => harness(["--session", "clock", ...args]);
    const started = await clock([
      "start", "--port", "4198", "--fixture", "blank",
      "--timezone", "Pacific/Kiritimati", "--clock", "install", "--now", "2026-03-08T06:59:00Z",
    ]);
    assert.equal(started.code, 0, started.stderr + started.stdout.slice(-2000));
    assert.equal((await readJson(".web-harness/clock/session.json")).environment.requested.clock, "install");
    assert.equal((await clock(["restart"])).code, 0);
    const moved = await clock(["run", "batches/clock.js"]);
    assert.equal(moved.code, 0, moved.stdout.slice(-2000));
    const report = JSON.parse(moved.stdout);
    assert.deepEqual(report.result, { now: "2026-03-08T07:31:00.000Z", timeZone: "Pacific/Kiritimati" });
    assert.equal((await clock(["stop"])).code, 0);
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
    assert.equal(report.status, "passed");
    assert.deepEqual(report.checks.map((check) => check.name), ["headers", "bundle", "globals", "a11y", "sw", "persist", "offline", "online", "update", "faults"]);
    const update = report.checks.find((check) => check.name === "update").detail;
    assert.deepEqual(update, { mode: "prompt", detected: true, consent: true, dismissed: "prompt returned after a reload", activated: true, navigations: 1 });
  });

  await t.test("a missing required header fails headers", async () => {
    const dist = await variant("headers", async (dir) => {
      const file = path.join(dir, "_headers");
      await writeFile(file, (await readFile(file, "utf8")).replace(/^\s*X-Content-Type-Options.*$/m, ""));
    });
    const { code, report } = await smoke(dist, "headers");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "headers");
    assert.match(report.error, /\/: missing x-content-type-options/);
  });

  await t.test("a header whose value regressed fails headers", async () => {
    const dist = await variant("csp", async (dir) => {
      const file = path.join(dir, "_headers");
      await writeFile(file, (await readFile(file, "utf8")).replace("script-src 'self'; ", ""));
    });
    const { code, report } = await smoke(dist, "csp");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "headers");
    assert.match(report.error, /content-security-policy .* does not match \/script-src 'self'\//);
  });

  await t.test("a long-cached service worker script fails headers", async () => {
    const dist = await variant("sw-cache", async (dir) => {
      const file = path.join(dir, "_headers");
      await writeFile(file, (await readFile(file, "utf8")).replace("Cache-Control: no-cache", "Cache-Control: public, max-age=31536000"));
    });
    const { code, report } = await smoke(dist, "sw-cache");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "headers");
    assert.match(report.error, /\/sw\.js: cache-control/);
  });

  await t.test("a new version that takes over without consent fails update", async () => {
    const dist = await variant("skip-waiting", async (dir) => {
      const file = path.join(dir, "sw.js");
      await writeFile(file, `self.addEventListener("install", () => self.skipWaiting());\n${await readFile(file, "utf8")}`);
    });
    const { code, report } = await smoke(dist, "skip-waiting");
    assert.equal(code, 1, JSON.stringify(report.checks));
    assert.equal(failedPhase(report), "update");
    assert.match(report.error, /activated without consent/);
  });

  await t.test("an activation that deletes the user's data fails update", async () => {
    const dist = await variant("wipe", async (dir) => {
      const file = path.join(dir, "sw.js");
      const wipe = `self.addEventListener("activate", (event) => event.waitUntil(new Promise((resolve) => {
  const request = indexedDB.deleteDatabase("notes");
  request.onsuccess = request.onerror = request.onblocked = () => resolve();
})));\n`;
      await writeFile(file, wipe + (await readFile(file, "utf8")));
    });
    const { code, report } = await smoke(dist, "wipe");
    assert.equal(code, 1, JSON.stringify(report.checks));
    assert.equal(failedPhase(report), "update");
    assert.match(report.error, /smoke note|Timeout/);
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

  await t.test("an icon button that lost its name fails a11y", async () => {
    const dist = await variant("a11y", async (dir) => {
      const index = path.join(dir, "index.html");
      await writeFile(index, (await readFile(index, "utf8")).replace(' aria-label="Clear note"', ""));
    });
    const { code, report } = await smoke(dist, "a11y");
    assert.equal(code, 1);
    assert.equal(failedPhase(report), "a11y");
    assert.match(report.error, /button-name \(critical\)/);
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
  // promote writes exactly the spec the example keeps: a batch became a test.
  const promoted = await harness([
    "promote", "batches/effects.js", "--to", "tests/e2e/promoted.spec.js", "--force",
    "--title", "a save changes the note and a cancel changes nothing", "--fixture", "blank", "--scenario", "save-note",
  ]);
  assert.equal(promoted.code, 0, promoted.stderr);
  assert.match(promoted.stdout, /covers: \[\{"file":"tests\/e2e\/promoted\.spec\.js"/);
  assert.equal((await exec("git", ["diff", "--exit-code", "tests/e2e/promoted.spec.js"], { cwd: root })).code, 0);
  const run = await harness(["e2e"]);
  assert.equal(run.code, 0, run.stderr + run.stdout.slice(-4000));
  const results = await readJson("e2e-results.json");
  const titles = JSON.stringify(results.suites);
  for (const title of ["a save changes the note and a cancel changes nothing", "an icon button without a name is an a11y fault", "a disabled rule excuses the finding but keeps it"])
    assert.ok(titles.includes(title), `ran: ${title}`);
  assert.ok(results.config.rootDir.startsWith(root), `not rehomed: ${results.config.rootDir}`);
  // The smoke test above left a passing report; given as the lane's report, it verifies the lane.
  const scenarios = await harness(["scenarios", "--results", "e2e-results.json", "--lane", "smoke=.web-harness/smoke-ok/report.json"]);
  assert.equal(scenarios.code, 0, scenarios.stderr + scenarios.stdout);
  assert.match(scenarios.stdout, /verified\s+save-note/);
  assert.match(scenarios.stdout, /verified\s+offline-install/);
  assert.match(scenarios.stdout, /unsupported\s+installed-phone/);
  const report = await readJson(".web-harness/scenarios.json");
  assert.equal(report.status, "passed");
  assert.match(report.source.commit, /^[0-9a-f]{40}$/);
  assert.match(report.results.digest, /^[0-9a-f]{64}$/);
  // The same suite in another timezone and locale.
  const zoned = await harness(["e2e", "--timezone", "Pacific/Kiritimati", "--locale", "en-GB", "--grep", "timezone"]);
  assert.equal(zoned.code, 0, zoned.stderr + zoned.stdout.slice(-3000));
  assert.equal((await readJson("e2e-results.json")).webHarness.timezone, "Pacific/Kiritimati");
});

test("playwright: a failing test carries the network and console evidence", { timeout: 10 * 60_000 }, async () => {
  const { root } = example;
  const spec = path.join(root, "tests/e2e/zz-failing.spec.js");
  await writeFile(
    spec,
    `import { expect, test } from "./fixtures.js";
test("fails on purpose", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#saved")).toHaveText("never", { timeout: 1000 });
});
`,
  );
  try {
    const run = await exec("npx", ["--no-install", "playwright", "test", "tests/e2e/zz-failing.spec.js", "--reporter=json"], {
      cwd: root,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: "zz-results.json" },
    });
    assert.equal(run.code, 1, "the test fails");
    const results = JSON.parse(await readFile(path.join(root, "zz-results.json"), "utf8"));
    const attempt = results.suites[0].specs[0].tests[0].results[0];
    const names = attempt.attachments.map((attachment) => attachment.name);
    for (const name of ["network.jsonl", "console.jsonl", "trace", "screenshot"])
      assert.ok(names.includes(name), `${name} in ${names}`);
    const network = attempt.attachments.find((attachment) => attachment.name === "network.jsonl");
    assert.match(Buffer.from(network.body, "base64").toString(), /"url":"http:\/\/127\.0\.0\.1:4192\/"/);
  } finally {
    await rm(spec, { force: true });
    await rm(path.join(root, "zz-results.json"), { force: true });
  }
});

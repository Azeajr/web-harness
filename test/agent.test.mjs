import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { a11yConfig, axeLoaderSource, axeSource, classifyA11y, runAxe } from "../src/a11y.mjs";
import { commands, toolCommands } from "../src/core.mjs";
import { batchHelpers } from "../src/playwright.mjs";
import { promotedSpec } from "../src/promote.mjs";
import {
  describeSkillDrift,
  describeSkillReach,
  installTargets,
  installedSkills,
  mentionedCommands,
  readSkill,
  stampSkill,
  stampedVersion,
} from "../src/skill.mjs";
import { ownVersion } from "../src/versions.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const example = path.join(repo, "examples/minimal");

test("the shipped skill names only commands the CLI has", async () => {
  const skill = await readSkill();
  const known = new Set([...commands, ...Object.keys(toolCommands)]);
  const mentioned = mentionedCommands(skill);
  assert.ok(mentioned.length >= 10, `found ${mentioned.join(", ")}`);
  assert.deepEqual(mentioned.filter((command) => !known.has(command)), []);
  assert.match(skill, /^---\nname: web-harness\ndescription: /);
});

test("an installed skill keeps its frontmatter first and is stamped with its version", async () => {
  const stamped = stampSkill(await readSkill(), "9.9.9");
  assert.match(stamped, /^---\nname: web-harness\n/);
  assert.equal(stampedVersion(stamped), "9.9.9");
  assert.equal(stampedVersion(await readSkill()), null);
  const root = await mkdtemp(path.join(os.tmpdir(), "wh-skill-"));
  try {
    assert.deepEqual(await installedSkills(root), []);
    await mkdir(path.join(root, ".claude/skills/web-harness"), { recursive: true });
    await writeFile(path.join(root, ".claude/skills/web-harness/SKILL.md"), stamped);
    const skills = await installedSkills(root, "1.0.0");
    assert.deepEqual(skills, [{ file: ".claude/skills/web-harness/SKILL.md", version: "9.9.9", ok: false }]);
    assert.match(describeSkillDrift(skills, "1.0.0")[0], /from web-harness 9\.9\.9; the package is 1\.0\.0/);
    const { main } = await import("../src/skill.mjs");
    await main(["install", "--dir", ".agents/skills"], { root });
    const installed = await readFile(path.join(root, ".agents/skills/web-harness/SKILL.md"), "utf8");
    assert.equal(stampedVersion(installed), ownVersion);
    await assert.rejects(main(["install", "--dir", "../elsewhere"], { root }), /inside the project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a bare skill install reaches Claude Code always and .agents/skills when the project has it", async () => {
  const { main } = await import("../src/skill.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "wh-skill-"));
  const current = async () => (await installedSkills(root)).map(({ file, ok }) => `${file} ${ok}`);
  try {
    assert.deepEqual(await installTargets(root), [".claude/skills"]);
    await mkdir(path.join(root, ".agents"));
    assert.deepEqual(await installTargets(root), [".claude/skills", ".agents/skills"]);

    // Installed only for Codex, in a project that also uses Claude Code: doctor says so.
    await mkdir(path.join(root, ".claude"));
    await main(["install", "--dir", ".agents/skills"], { root });
    assert.deepEqual(await current(), [".agents/skills/web-harness/SKILL.md true"]);
    assert.match((await describeSkillReach(root, await installedSkills(root)))[0], /Claude Code loads project skills from \.claude\/skills alone/);

    // One bare install afterwards reaches both and refreshes the stale copy.
    await writeFile(path.join(root, ".agents/skills/web-harness/SKILL.md"), stampSkill(await readSkill(), "0.0.1"));
    assert.match(describeSkillDrift(await installedSkills(root))[0], /Run `web-harness skill install`\.$/);
    await main(["install"], { root });
    assert.deepEqual(await current(), [".claude/skills/web-harness/SKILL.md true", ".agents/skills/web-harness/SKILL.md true"]);
    assert.deepEqual(await describeSkillReach(root, await installedSkills(root)), []);

    // --dir is exact and repeatable.
    await rm(path.join(root, ".claude/skills"), { recursive: true });
    await rm(path.join(root, ".agents/skills"), { recursive: true });
    await main(["install", "--dir", ".claude/skills", "--dir", "./.claude/skills"], { root });
    assert.deepEqual(await current(), [".claude/skills/web-harness/SKILL.md true"]);

    // A hand-made link from .claude/skills to the .agents copy is written through, not replaced.
    await rm(path.join(root, ".claude/skills"), { recursive: true });
    await mkdir(path.join(root, ".agents/skills/web-harness"), { recursive: true });
    await mkdir(path.join(root, ".claude/skills"));
    await symlink("../../.agents/skills/web-harness", path.join(root, ".claude/skills/web-harness"));
    await main(["install"], { root });
    assert.ok((await lstat(path.join(root, ".claude/skills/web-harness"))).isSymbolicLink());
    assert.deepEqual(await current(), [".claude/skills/web-harness/SKILL.md true", ".agents/skills/web-harness/SKILL.md true"]);

    // A Codex-only project is not told to install for Claude Code.
    await rm(path.join(root, ".claude"), { recursive: true });
    assert.deepEqual(await describeSkillReach(root, await installedSkills(root)), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("promote writes a spec that parses, and the example's promoted spec is what it writes", async () => {
  const batchFile = path.join(example, "batches/effects.js");
  const options = {
    root: example,
    batchFile,
    source: await readFile(batchFile, "utf8"),
    specFile: path.join(example, "tests/e2e/promoted.spec.js"),
    title: "a save changes the note and a cancel changes nothing",
    fixture: "blank",
    fixturesFile: path.join(example, "tests/e2e/fixtures.js"),
    target: "production",
  };
  const spec = promotedSpec(options);
  assert.equal(spec, await readFile(options.specFile, "utf8"), "regenerate tests/e2e/promoted.spec.js");
  assert.match(spec, /import { expect, test } from "\.\/fixtures\.js";/);
  assert.match(spec, /import harness from "\.\.\/\.\.\/harness\.config\.mjs";/);
  const typescript = promotedSpec({ ...options, specFile: path.join(example, "tests/e2e/deep/x.spec.ts"), fixturesFile: path.join(example, "tests/e2e/fixtures.ts") });
  assert.match(typescript, /import type { HarnessBatch }/);
  assert.match(typescript, /from "\.\.\/fixtures";/);
  assert.match(typescript, /const batch: HarnessBatch =/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-promote-"));
  try {
    await writeFile(path.join(directory, "spec.mjs"), spec);
    await promisify(execFile)(process.execPath, ["--check", path.join(directory, "spec.mjs")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(() => promotedSpec({ ...options, source: "async (page) => {" }));
});

test("batch helpers in a test: step is test.step, assert is expect, faults go to the guard", async () => {
  const calls = [];
  const helpers = batchHelpers({ context: () => ({}) }, { environment: { clock: "install", now: "2026-01-01T00:00:00Z" } }, {
    test: { step: async (name, action) => (calls.push(["step", name]), action()) },
    expect: (value, message) => ({ toBeTruthy: () => calls.push(["expect", value, message]) }),
    allowPageFaults: (pattern) => calls.push(["allow", pattern]),
    expectPageFault: (kind, pattern) => calls.push(["expectFault", kind, pattern]),
  });
  assert.equal(await helpers.step("one", () => 1), 1);
  helpers.assert(true, "holds");
  helpers.allowFault(/noise/);
  helpers.expectFault("http", /500/);
  assert.equal(helpers.clock.mode, "install");
  assert.deepEqual(calls, [["step", "one"], ["expect", true, "holds"], ["allow", "noise"], ["expectFault", "http", "500"]]);
  const production = batchHelpers({ url: () => "http://x/" }, { state: { sections: ["note"], defaults: ["note"], read: () => ({}) } }, { target: "production" });
  assert.match((await production.state(["note"])).unsupported, /Production builds carry no development accessors/);
});

test("a11y config and classification: impact threshold, disabled rules kept and excused", () => {
  assert.deepEqual(a11yConfig({}), { impact: "serious", disable: [], include: [], exclude: [] });
  assert.equal(a11yConfig({ impact: "minor" }, { impact: "critical" }).impact, "critical");
  assert.throws(() => a11yConfig({ impact: "severe" }), /a11y\.impact/);
  assert.throws(() => a11yConfig({ disable: "button-name" }), /a11y\.disable/);
  const violations = [
    { rule: "button-name", impact: "critical", help: "Buttons must have discernible text", helpUrl: "u1", count: 1, targets: ["#clear"] },
    { rule: "region", impact: "moderate", help: "All page content should be contained by landmarks", helpUrl: "u2", count: 2, targets: ["p", "h1"] },
  ];
  const strict = classifyA11y(violations, a11yConfig({}));
  assert.deepEqual(strict.faults.map((fault) => [fault.kind, fault.rule, fault.excusedBy]), [["a11y", "button-name", undefined]]);
  assert.deepEqual(strict.warnings.map((warning) => warning.kind), ["a11y-warning"]);
  assert.match(strict.faults[0].detail, /button-name \(critical\): Buttons must have discernible text — 1 × #clear — u1/);
  const disabled = classifyA11y(violations, a11yConfig({ disable: ["button-name"] }));
  assert.equal(disabled.faults[0].excusedBy, "a11y.disable", "kept as evidence, not counted");
});

test("axe runs in a real page, through a function, under a strict CSP", { timeout: 60_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    t.skip(`No Chromium for this Playwright (${error.message.split("\n")[0]})`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.route("http://a11y.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "content-security-policy": "default-src 'self'; script-src 'self'" },
        body: '<!doctype html><html lang="en"><title>t</title><main><button id="clear"><svg aria-hidden="true" width="8" height="8"></svg></button><button aria-label="Save">✓</button></main>',
      }),
    );
    await page.goto("http://a11y.test/");
    const loadAxe = new Function(`return (${axeLoaderSource(await axeSource(repo))})`)();
    const settings = a11yConfig({});
    const found = classifyA11y(await runAxe(page, settings, loadAxe), settings);
    assert.deepEqual(found.faults.map((fault) => [fault.rule, fault.targets]), [["button-name", ["#clear"]]]);
    // Loaded once per document.
    assert.equal(await page.evaluate(() => typeof window.axe.run), "function");
    const scoped = classifyA11y(await runAxe(page, a11yConfig({ exclude: ["#clear"] }), loadAxe), settings);
    assert.deepEqual(scoped.faults, []);
  } finally {
    await browser.close();
  }
});

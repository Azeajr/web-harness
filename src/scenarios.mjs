import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { slug } from "./core.mjs";
import { loadConfig } from "./config.mjs";

// web-harness scenarios [--results playwright-results.json] [--output FILE] [--allow-flaky]
//
// The executable scenario inventory. Each critical journey the project names in
// harness.config.mjs must either map to conventional tests that exist (and, given a Playwright
// JSON report, passed in this run) or say plainly why it has no coverage. A scenario is never
// "covered" by an agent's one-off exploration; exploration becomes coverage by landing a test.
//
//   scenarios: [
//     { id: 'finish-session', title: 'Finish a logged session', covers: [
//         { file: 'tests/e2e/workout.spec.ts', test: 'finishes a session and persists it' } ] },
//     { id: 'offline-install', title: 'Installs and works offline', covers: [
//         { lane: 'smoke' } ] },           // a required CI job that proves it, not a spec
//     { id: 'ios-audio', title: 'Rest alert on a locked iPhone', status: 'unsupported',
//       reason: 'Needs a real device; see docs/verification/…' },
//   ]
export function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios)) throw new Error("scenarios must be an array.");
  const ids = new Set();
  for (const scenario of scenarios) {
    slug(scenario.id, "scenario id");
    if (ids.has(scenario.id)) throw new Error(`Duplicate scenario id ${scenario.id}.`);
    ids.add(scenario.id);
    if (!scenario.title) throw new Error(`Scenario ${scenario.id} needs a title.`);
    if (scenario.status) {
      if (!["unsupported", "not-run"].includes(scenario.status))
        throw new Error(`Scenario ${scenario.id}: status is unsupported or not-run.`);
      if (!scenario.reason) throw new Error(`Scenario ${scenario.id}: a ${scenario.status} scenario needs a reason.`);
      if (scenario.covers?.length)
        throw new Error(`Scenario ${scenario.id}: ${scenario.status} scenarios cover nothing.`);
    } else if (!scenario.covers?.length)
      throw new Error(`Scenario ${scenario.id} covers no test and gives no status/reason.`);
    for (const cover of scenario.covers ?? [])
      if (cover.lane ? typeof cover.lane !== "string" : !cover.file || !cover.test)
        throw new Error(`Scenario ${scenario.id}: each cover is { file, test } or { lane }.`);
  }
  return scenarios;
}

// A title written as a template literal (`${route} shows …`) runs once per value: match every
// expansion of it. Any other title matches exactly.
export function titleMatcher(title) {
  if (!title.includes("${")) return (candidate) => candidate === title;
  const pattern = new RegExp(
    `^${title
      .split(/\$\{[^}]*\}/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+")}$`,
  );
  return (candidate) => pattern.test(candidate);
}

// Flatten a Playwright JSON report into { file, title, outcome, attempts } rows. `title` is the
// test's own title; describe blocks are not part of the match. Every attempt is kept: a retry that
// passed does not erase the failure before it.
export function flattenResults(report, rootDir = "") {
  const rows = [];
  const visit = (suite, file) => {
    const current = suite.file ?? file;
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        rows.push({
          file: path.normalize(path.join(rootDir, spec.file ?? current)),
          title: spec.title,
          project: test.projectName,
          outcome: test.status ?? test.results?.at(-1)?.status,
          attempts: (test.results ?? []).map((result) => ({
            retry: result.retry ?? 0,
            status: result.status,
            ms: result.duration ?? null,
            error: result.error?.message?.split("\n")[0]?.slice(0, 300) ?? null,
          })),
        });
    for (const child of suite.suites ?? []) visit(child, current);
  };
  for (const suite of report.suites ?? []) visit(suite, suite.file);
  return rows;
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      results: { type: "string" },
      output: { type: "string", default: ".web-harness/scenarios.json" },
      "allow-flaky": { type: "boolean", default: false },
    },
    strict: true,
  });
  const config = await loadConfig();
  const scenarios = validateScenarios(config.scenarios);
  let rows = null;
  if (values.results) {
    const report = JSON.parse(await readFile(path.resolve(config.root, values.results), "utf8"));
    const testDir = path.relative(config.root, report.config?.rootDir ?? config.root);
    rows = flattenResults(report, testDir);
  }
  const problems = [];
  const results = [];
  for (const scenario of scenarios) {
    if (scenario.status) {
      results.push({ id: scenario.id, status: scenario.status, reason: scenario.reason });
      continue;
    }
    const covered = [];
    let flaky = false;
    for (const cover of scenario.covers) {
      if (cover.lane) {
        covered.push(cover); // proven by a required CI lane; the verdict job holds it to that
        continue;
      }
      const file = path.resolve(config.root, cover.file);
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        problems.push(`${scenario.id}: ${cover.file} does not exist.`);
        continue;
      }
      const quoted = [`'${cover.test}'`, `"${cover.test}"`, `\`${cover.test}\``];
      if (!quoted.some((form) => text.includes(form))) {
        problems.push(`${scenario.id}: no test titled "${cover.test}" in ${cover.file}.`);
        continue;
      }
      if (rows) {
        const matchesTitle = titleMatcher(cover.test);
        const matches = rows.filter(
          (row) => row.file === path.normalize(cover.file) && matchesTitle(row.title),
        );
        if (!matches.length) problems.push(`${scenario.id}: "${cover.test}" did not run.`);
        for (const match of matches) {
          if (match.outcome === "flaky") {
            flaky = true;
            const failed = match.attempts.filter((attempt) => attempt.status !== "passed").length;
            if (!values["allow-flaky"])
              problems.push(
                `${scenario.id}: "${cover.test}" [${match.project}] flaky — failed ${failed} attempt(s) before passing.`,
              );
          } else if (!["expected", "passed"].includes(match.outcome))
            problems.push(`${scenario.id}: "${cover.test}" [${match.project}] ${match.outcome}.`);
        }
        covered.push({
          ...cover,
          outcomes: matches.map((match) => `${match.project}:${match.outcome}`),
          attempts: matches.map((match) => ({ project: match.project, attempts: match.attempts })),
        });
      } else covered.push(cover);
    }
    results.push({ id: scenario.id, status: rows ? (flaky ? "flaky" : "verified") : "mapped", covers: covered });
  }
  await mkdir(path.dirname(path.resolve(config.root, values.output)), { recursive: true });
  await writeFile(
    path.resolve(config.root, values.output),
    JSON.stringify({ project: config.name, allowFlaky: values["allow-flaky"], results, problems }, null, 2) + "\n",
  );
  for (const result of results)
    console.log(`${result.status.padEnd(12)}${result.id}${result.reason ? ` — ${result.reason}` : ""}`);
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exitCode = 1;
  }
}

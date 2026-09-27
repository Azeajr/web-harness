import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Script } from "node:vm";
import { loadConfig } from "./config.mjs";
import { contained } from "./core.mjs";

// web-harness promote BATCH_FILE --to tests/e2e/NAME.spec.ts --title "…" [--fixture NAME]
//                    [--scenario ID] [--target dev|production] [--force]
//
// The last step of the loop: a batch that reproduced something becomes an ordinary test. The spec
// imports the project's own `test` and `expect` (config e2e.fixtures), seeds with the same fixture
// through applyHarnessFixture, and runs the batch function unchanged with batchHelpers — step is
// test.step, assert is expect, faults go through the same guard. It prints the `covers` entry for
// the scenario instead of editing harness.config.mjs. --target names what the suite's webServer
// serves (default: production when the project has a build): on production, `state` answers
// unsupported, so a batch that reads it needs rewriting against visible UI or `durable`.

const importPath = (fromDirectory, file, { dropTs }) => {
  let relative = path.relative(fromDirectory, file).split(path.sep).join("/");
  if (dropTs) relative = relative.replace(/\.ts$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
};

// Pure: the spec text for one promoted batch.
export function promotedSpec({ root, batchFile, source, specFile, title, fixture, fixturesFile, target = "dev" }) {
  const expression = source.trim().replace(/;$/, "");
  new Script(`(${expression})`); // a malformed batch fails here, not in the suite
  const typescript = /\.[cm]?tsx?$/.test(specFile);
  const directory = path.dirname(specFile);
  const typeImport = typescript ? `import type { HarnessBatch } from "@azeajr/web-harness/playwright";\n` : "";
  const declaration = typescript
    ? "const batch: HarnessBatch ="
    : '/** @type {import("@azeajr/web-harness/playwright").HarnessBatch} */\nconst batch =';
  return `// Promoted from ${path.relative(root, batchFile).split(path.sep).join("/")} by \`web-harness promote\`.
// The batch runs unchanged: step is test.step, assert is expect, faults go through the same guard,
// and the page is seeded with the "${fixture}" fixture exactly as a session is.
${typeImport}import { applyHarnessFixture, batchHelpers } from "@azeajr/web-harness/playwright";
import harness from "${importPath(directory, path.join(root, "harness.config.mjs"), { dropTs: false })}";
import { expect, test } from "${importPath(directory, fixturesFile, { dropTs: typescript })}";

${declaration}
${expression};

test(${JSON.stringify(title)}, async ({ page, allowPageFaults, expectPageFault }) => {
  await applyHarnessFixture(page, harness, ${JSON.stringify(fixture)});
  const helpers = batchHelpers(page, harness, { test, expect, allowPageFaults, expectPageFault, target: ${JSON.stringify(target)} });
  const result = await batch(page, helpers);
  await test.info().attach("batch-result.json", {
    body: JSON.stringify(result ?? null, null, 2),
    contentType: "application/json",
  });
});
`;
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      to: { type: "string" },
      title: { type: "string" },
      fixture: { type: "string" },
      scenario: { type: "string" },
      target: { type: "string" },
      force: { type: "boolean" },
    },
  });
  if (positionals.length !== 1 || !values.to || !values.title)
    throw new Error('Usage: web-harness promote BATCH_FILE --to tests/e2e/NAME.spec.ts --title "…" [--fixture NAME] [--scenario ID]');
  const config = await loadConfig();
  const root = config.root;
  const inside = (value, label) => {
    const resolved = path.resolve(root, value);
    if (!contained(root, resolved)) throw new Error(`${label} must be inside the project (${root}).`);
    return resolved;
  };
  const batchFile = inside(positionals[0], "The batch");
  const specFile = inside(values.to, "--to");
  const target = values.target ?? (config.production ? "production" : "dev");
  if (!["dev", "production"].includes(target)) throw new Error("--target must be dev or production.");
  const fixture = values.fixture ?? config.defaultFixture;
  if (!config.fixtures[fixture])
    throw new Error(`Unknown fixture ${fixture}. Registered: ${Object.keys(config.fixtures).join(", ")}.`);
  if (values.scenario && !config.scenarios.some((scenario) => scenario.id === values.scenario))
    throw new Error(`Unknown scenario ${values.scenario}. Registered: ${config.scenarios.map((scenario) => scenario.id).join(", ") || "(none)"}.`);
  const fixturesFile = inside(config.e2e?.fixtures ?? "tests/e2e/fixtures.ts", "e2e.fixtures");
  await access(fixturesFile).catch(() => {
    throw new Error(
      `${path.relative(root, fixturesFile)} does not exist. Set e2e.fixtures in harness.config.mjs to the module that exports the project's test (createHarnessTest) and expect.`,
    );
  });
  if (!values.force && (await access(specFile).then(() => true, () => false)))
    throw new Error(`${path.relative(root, specFile)} exists; pass --force to replace it.`);
  const spec = promotedSpec({
    root,
    batchFile,
    source: await readFile(batchFile, "utf8"),
    specFile,
    title: values.title,
    fixture,
    fixturesFile,
    target,
  });
  await mkdir(path.dirname(specFile), { recursive: true });
  await writeFile(specFile, spec);
  const cover = { file: path.relative(root, specFile).split(path.sep).join("/"), test: values.title };
  console.log(`Wrote ${cover.file}. Run it: web-harness e2e --grep ${JSON.stringify(values.title)}`);
  console.log(
    `${values.scenario ? `Add under scenario "${values.scenario}"` : "Add under the scenario it proves"} in harness.config.mjs:\n  covers: [${JSON.stringify(cover)}]`,
  );
}

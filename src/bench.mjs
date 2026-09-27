import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { summarize } from "./metrics.mjs";
import { formatSize } from "./resources.mjs";

// web-harness bench [--repeat 5] [--port P] [--fixture NAME] [--target dev|production]
//
// Measures the harness on this project with one fixed sequence, repeated: start; three `state`
// reads as separate commands, then the same three in one batch (the batching claim, measured);
// reload; restart; reset; stop. Prints the median and p90 of each step with the conditions they
// were measured under, and writes them to .web-harness/bench/. No budgets until there are
// baselines: this collects them. Heavy — a full session per repetition — so run it alone.

const BATCH = `// Written by web-harness bench: three state reads in one transport call.
async (page, { state }) => [await state(), await state(), await state()]
`;

function timed(bin, args, cwd) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("close", (code) => resolve({ code, ms: Math.round(performance.now() - started), output }));
  });
}

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repeat: { type: "string", default: "5" },
      port: { type: "string" },
      fixture: { type: "string" },
      target: { type: "string", default: "dev" },
      session: { type: "string", default: "bench" },
    },
    strict: true,
  });
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) throw new Error("--repeat must be 1 to 50.");
  if (!["dev", "production"].includes(values.target)) throw new Error("--target must be dev or production.");
  const config = await loadConfig();
  const root = config.root;
  const bin = fileURLToPath(new URL("../bin/web-harness.mjs", import.meta.url));
  const directory = path.join(root, ".web-harness/bench");
  await mkdir(directory, { recursive: true });
  const batchFile = path.join(directory, "three-states.js");
  await writeFile(batchFile, BATCH);
  const session = ["--session", values.session];
  const startArgs = [
    "start",
    "--target",
    values.target,
    ...(values.port ? ["--port", values.port] : []),
    ...(values.fixture ? ["--fixture", values.fixture] : []),
  ];
  const steps = [
    ["start", startArgs],
    ["state 1", ["state"]],
    ["state 2", ["state"]],
    ["state 3", ["state"]],
    ["batch of 3 states", ["run", path.relative(root, batchFile)]],
    ["reload", ["reload"]],
    ["restart", ["restart"]],
    ["reset", ["reset"]],
    ["stop", ["stop"]],
  ];
  const samples = Object.fromEntries([...steps.map(([name]) => [name, []]), ["3 separate states", []]]);
  const manifests = [];
  const readManifest = () =>
    readFile(path.join(root, ".web-harness", values.session, "session.json"), "utf8").then(JSON.parse, () => null);
  for (let round = 1; round <= repeat; round++) {
    for (const [name, args] of steps) {
      if (name === "stop") manifests.push(await readManifest());
      const result = await timed(bin, [...session, ...args], root);
      if (result.code !== 0) {
        if (name !== "stop") await timed(bin, [...session, "stop"], root);
        throw new Error(`bench round ${round}: ${name} failed (exit ${result.code}):\n${result.output.slice(-3000)}`);
      }
      samples[name].push(result.ms);
      console.error(`round ${round}/${repeat}  ${name.padEnd(18)} ${String(result.ms).padStart(6)} ms`);
    }
    samples["3 separate states"].push(samples["state 1"].at(-1) + samples["state 2"].at(-1) + samples["state 3"].at(-1));
  }
  const last = manifests.at(-1);
  const report = {
    project: config.name,
    at: new Date().toISOString(),
    repeat,
    conditions: {
      host: { cores: os.availableParallelism(), memory: formatSize(os.totalmem()), platform: `${os.platform()} ${os.release()}` },
      node: process.version,
      playwright: last?.driver?.playwright ?? null,
      image: last?.image ?? null,
      browser: last?.browser ?? null,
      device: last?.device ?? null,
      target: values.target,
      limits: last?.limits ?? null,
    },
    steps: Object.fromEntries(Object.entries(samples).map(([name, list]) => [name, { ...summarize(list), samples: list }])),
    peaks: manifests.map((manifest) => manifest?.metrics ?? null),
  };
  const file = path.join(directory, `${report.at.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  console.log(`${"step".padEnd(20)}${"median".padStart(8)}${"p90".padStart(8)}  (ms, n=${repeat})`);
  for (const [name, summary] of Object.entries(report.steps))
    console.log(`${name.padEnd(20)}${String(summary.median).padStart(8)}${String(summary.p90).padStart(8)}`);
  console.log(
    `Conditions: ${report.conditions.host.cores} cores, ${report.conditions.host.memory}, ${report.conditions.image}, ${report.conditions.browser}/${report.conditions.device}, ${values.target}.`,
  );
  console.log(`Report: ${file}`);
}

import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { imageFor } from "./core.mjs";
import { loadConfig } from "./config.mjs";

// web-harness e2e [--update-snapshots] [playwright args...]
//
// The authoritative browser run: the working tree (tracked, modified and untracked-but-not-ignored
// files) copied into a throwaway workspace, installed from the lockfile inside the Playwright image
// that matches the project's Playwright version, and run with bounded memory and CPU. Pixel
// baselines therefore come from one canonical environment — the one CI uses — instead of whichever
// host last ran --update-snapshots. The host checkout is never written except for the report and,
// with --update-snapshots, the PNG baselines.
class DockerFailure extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Where the throwaway workspace is mounted inside the container.
export const CONTAINER_WORKSPACE = "/work";

// Playwright's JSON report names paths as the container saw them (/work/...). Brought back to the
// host they must name the checkout, or everything keyed on them — the scenario join above all —
// finds nothing ("did not run" for every test that did).
export function rehomeResults(report, root) {
  const rehome = (value) =>
    typeof value === "string" &&
    (value === CONTAINER_WORKSPACE || value.startsWith(`${CONTAINER_WORKSPACE}/`))
      ? path.join(root, path.relative(CONTAINER_WORKSPACE, value))
      : value;
  if (report.config) {
    report.config.rootDir = rehome(report.config.rootDir);
    report.config.configFile = rehome(report.config.configFile);
    for (const project of report.config.projects ?? []) {
      project.testDir = rehome(project.testDir);
      project.outputDir = rehome(project.outputDir);
    }
  }
  return report;
}

function packageManager(config) {
  return config.e2e?.install ??
    (config.packageManager === "npm" ? "npm ci --no-audit --no-fund" : "pnpm install --frozen-lockfile");
}

export async function main(argv) {
  const config = await loadConfig();
  const root = config.root;
  const e2e = {
    config: "playwright.config.ts",
    prepare: [],
    snapshots: ["tests/e2e"],
    report: "playwright-report",
    ...config.e2e,
  };
  const updateSnapshots = argv.includes("--update-snapshots");
  // --prebuilt DIR: copy an already-built output (CI's checked artifact) into the workspace and
  // tell the suite not to rebuild it, so the container tests the bytes that ship.
  const prebuiltIndex = argv.indexOf("--prebuilt");
  const prebuilt = prebuiltIndex >= 0 ? argv[prebuiltIndex + 1] : null;
  if (prebuiltIndex >= 0 && !prebuilt) throw new Error("--prebuilt needs a directory.");
  const playwrightArgs = argv.filter(
    (arg, index) =>
      arg !== "--update-snapshots" && index !== prebuiltIndex && index !== prebuiltIndex + 1,
  );
  const require = createRequire(path.join(config.playwrightFrom, "package.json"));
  const playwrightVersion = require("playwright/package.json").version;
  const image = imageFor(playwrightVersion);
  const dockerNetwork = process.env.WEB_HARNESS_E2E_NETWORK;
  if (dockerNetwork && !["host", "bridge"].includes(dockerNetwork))
    throw new Error("WEB_HARNESS_E2E_NETWORK must be host or bridge.");
  // A container overrun must kill the container, not the host: these bound the run well below a
  // developer machine's total memory. Playwright otherwise defaults to half the logical cores.
  const dockerMemory = process.env.WEB_HARNESS_E2E_MEMORY ?? "6g";
  // Docker refuses --cpus above the host's core count, and CI runners vary: a private repo's
  // GitHub-hosted runner has 2 cores where a public one has 4. Clamp the default to what exists.
  const dockerCpus = process.env.WEB_HARNESS_E2E_CPUS ?? String(Math.min(4, availableParallelism()));
  const callerSetWorkers = playwrightArgs.some(
    (arg) => arg === "--workers" || arg === "-j" || /^(--workers|-j)=/.test(arg),
  );
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `wh-e2e-${config.name}-`));
  const workspace = path.join(temporaryRoot, "work");
  const containerName = `wh-e2e-${config.name}-${process.pid}`;
  let activeDocker;
  let testStarted = false;
  let interruptedBy;
  let exitStatus = 0;
  const interruptionStatus = () => (interruptedBy === "SIGINT" ? 130 : 143);
  const assertNotInterrupted = () => {
    if (interruptedBy)
      throw new DockerFailure(`Container run interrupted by ${interruptedBy}.`, interruptionStatus());
  };

  function docker(args, message, { cleanup = false } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { cwd: root, stdio: cleanup ? "ignore" : "inherit" });
      activeDocker = child;
      child.on("error", (error) => {
        activeDocker = undefined;
        reject(new DockerFailure(`Docker is required for container E2E: ${error.message}`, 1));
      });
      child.on("close", (status) => {
        activeDocker = undefined;
        if (status === 0) resolve();
        else reject(new DockerFailure(message, status || 1));
      });
    });
  }
  const handleSignal = (signal) => {
    if (interruptedBy) return;
    interruptedBy = signal;
    activeDocker?.kill(signal);
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  function gitWorkingTreeFiles() {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        ["ls-files", "--cached", "--modified", "--others", "--exclude-standard", "-z"],
        { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
      );
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (status) => {
        if (status !== 0) return reject(new Error("Unable to enumerate the Git working tree."));
        resolve(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean));
      });
    });
  }

  async function copyWorkingTree() {
    for (const relative of new Set(await gitWorkingTreeFiles())) {
      const source = path.resolve(root, relative);
      const destination = path.resolve(workspace, relative);
      if (
        !source.startsWith(`${root}${path.sep}`) ||
        !destination.startsWith(`${workspace}${path.sep}`)
      )
        throw new Error(`Refusing to copy a path outside the working tree: ${relative}`);
      try {
        await access(source);
      } catch {
        continue; // deleted in the working tree
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { force: true });
    }
  }

  async function pngSnapshots(base) {
    const snapshots = new Set();
    for (const directory of e2e.snapshots) {
      const parent = path.join(base, directory);
      let entries;
      try {
        entries = await readdir(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.endsWith("-snapshots")) continue;
        for (const file of await readdir(path.join(parent, entry.name), { withFileTypes: true }))
          if (file.isFile() && file.name.endsWith(".png"))
            snapshots.add(path.join(directory, entry.name, file.name));
      }
    }
    return snapshots;
  }

  async function syncSnapshots() {
    const [updated, existing] = await Promise.all([pngSnapshots(workspace), pngSnapshots(root)]);
    for (const relative of existing)
      if (!updated.has(relative)) await rm(path.join(root, relative), { force: true });
    for (const relative of updated) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await cp(path.join(workspace, relative), path.join(root, relative), { force: true });
    }
  }

  async function copyReport() {
    try {
      const report = JSON.parse(await readFile(path.join(workspace, "e2e-results.json"), "utf8"));
      await writeFile(
        path.join(root, "e2e-results.json"),
        JSON.stringify(rehomeResults(report, root), null, 2) + "\n",
      );
    } catch (error) {
      // The run died before the reporter wrote anything: say so rather than leave stale results.
      if (error.code !== "ENOENT") throw error;
      await rm(path.join(root, "e2e-results.json"), { force: true });
    }
    const source = path.join(workspace, e2e.report);
    try {
      await access(source);
    } catch {
      return;
    }
    const destination = path.join(root, e2e.report);
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, force: true });
  }

  try {
    console.log(
      `Playwright ${playwrightVersion}; image ${image}; memory ${dockerMemory}; cpus ${dockerCpus}; workers ${callerSetWorkers ? "caller-set" : 1}`,
    );
    await docker(["pull", image], `Required Playwright image is unavailable: ${image}`);
    assertNotInterrupted();
    await copyWorkingTree();
    if (prebuilt) {
      const relative = path.relative(root, path.resolve(root, prebuilt));
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("--prebuilt must be inside the repository.");
      await cp(path.join(root, relative), path.join(workspace, relative), { recursive: true });
    }
    assertNotInterrupted();
    const command = [
      "set -eu",
      // The image ships Node with corepack; a pnpm shim keeps the lockfile's pnpm major.
      "mkdir -p /tmp/pnpm-bin",
      String.raw`printf '%s\n' '#!/bin/sh' 'exec corepack pnpm "$@"' > /tmp/pnpm-bin/pnpm`,
      "chmod +x /tmp/pnpm-bin/pnpm",
      "export PATH=/tmp/pnpm-bin:$PATH",
      packageManager(config),
      ...e2e.prepare,
      `npx --no-install playwright test --config ${JSON.stringify(e2e.config)} --reporter=list,html,json${updateSnapshots ? " --update-snapshots" : ""}${callerSetWorkers ? "" : " --workers=1"} "$@"`,
    ].join("\n");
    testStarted = true;
    await docker(
      [
        "run",
        "--rm",
        "--init",
        "--ipc=host",
        "--memory",
        dockerMemory,
        // Equal swap disables swap for the container: Docker otherwise grants twice the bound.
        "--memory-swap",
        dockerMemory,
        "--cpus",
        dockerCpus,
        ...(dockerNetwork ? ["--network", dockerNetwork] : []),
        "--name",
        containerName,
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "-e",
        "CI=1",
        // The canonical environment: suites gate pixel baselines on this, so screenshots are
        // only ever compared where they were taken.
        "-e",
        "WEB_HARNESS_CONTAINER=1",
        // JSON results come back beside the HTML report, for `web-harness scenarios --results`.
        "-e",
        `PLAYWRIGHT_JSON_OUTPUT_NAME=${CONTAINER_WORKSPACE}/e2e-results.json`,
        ...(prebuilt ? ["-e", "WEB_HARNESS_PREBUILT=1"] : []),
        "-e",
        "HOME=/tmp",
        "-e",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
        "-v",
        `${workspace}:${CONTAINER_WORKSPACE}`,
        "-w",
        CONTAINER_WORKSPACE,
        image,
        "bash",
        "-lc",
        command,
        "web-harness-e2e",
        ...playwrightArgs,
      ],
      "Container E2E failed.",
    );
    assertNotInterrupted();
    if (updateSnapshots) {
      await syncSnapshots();
      console.log("Updated PNG baselines copied from the canonical container.");
    }
  } catch (error) {
    if (!(error instanceof DockerFailure)) throw error;
    console.error(error.message);
    exitStatus = error.status;
  } finally {
    if (testStarted) {
      try {
        await copyReport();
      } catch (error) {
        console.error(`Unable to copy Playwright report: ${error.message}`);
        exitStatus ||= 1;
      }
    }
    await docker(["rm", "--force", containerName], "Unable to remove container.", {
      cleanup: true,
    }).catch(() => {});
    await rm(temporaryRoot, { recursive: true, force: true });
    if (interruptedBy) exitStatus = interruptionStatus();
  }
  if (exitStatus) process.exitCode = exitStatus;
}

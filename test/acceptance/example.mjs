import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The acceptance suite drives the harness the way a consumer does: web-harness is packed, the
// example app installs the tarball, and every command runs through the installed bin. Nothing
// here imports the harness's internals.

export const repo = fileURLToPath(new URL("../..", import.meta.url));
const exampleSource = path.join(repo, "examples/minimal");
const IGNORED = /^(node_modules|dist|\.web-harness|test-results|playwright-report|reports|vendor)(\/|$)|^e2e-results\.json$/;

export function exec(command, args, { cwd, timeout = 600_000, env = process.env } = {}) {
  return new Promise((resolve) =>
    execFile(command, args, { cwd, timeout, env, maxBuffer: 64 << 20 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    ),
  );
}

async function must(command, args, options) {
  const result = await exec(command, args, options);
  if (result.code !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (${result.code}):\n${result.stderr || result.stdout}`);
  return result.stdout;
}

// A fresh copy of the example with the current working tree's web-harness packed into it. The
// tarball sits inside the app so the container E2E run, which sees only the app, can install it.
export async function prepareExample() {
  const base =
    process.env.WEB_HARNESS_ACCEPTANCE_DIR ??
    (await mkdtemp(path.join(os.tmpdir(), "wh-acceptance-")));
  await mkdir(base, { recursive: true });
  const app = path.join(base, `app-${process.pid}`);
  await cp(exampleSource, app, {
    recursive: true,
    filter: (source) => !IGNORED.test(path.relative(exampleSource, source)),
  });
  const vendor = path.join(app, "vendor");
  await mkdir(vendor);
  await must("npm", ["pack", "--silent", "--pack-destination", vendor], { cwd: repo });
  const [tarball] = (await readdir(vendor)).filter((name) => name.endsWith(".tgz"));
  await rename(path.join(vendor, tarball), path.join(vendor, "web-harness.tgz"));
  const manifest = JSON.parse(await readFile(path.join(app, "package.json"), "utf8"));
  manifest.devDependencies["@azeajr/web-harness"] = "file:vendor/web-harness.tgz";
  await writeFile(path.join(app, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  // Resolve the complete dependency graph before installing platform-specific optional packages.
  // A lock generated during installation can omit foreign Rollup binaries and fail npm ci in
  // the pinned Playwright image. Use that same clean-install contract on the host as well.
  await must("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app });
  await must("npm", ["ci", "--no-audit", "--no-fund"], { cwd: app });
  // The repository's copy ignores its lockfile (it would pin file:../..); this copy's lockfile pins
  // the tarball and is what the container E2E run installs from, so it must be tracked.
  const ignore = path.join(app, ".gitignore");
  await writeFile(ignore, (await readFile(ignore, "utf8")).replace(/^package-lock\.json\n/m, ""));
  // The container E2E runner copies the Git working tree, so the app is its own repository.
  await must("git", ["init", "-q"], { cwd: app });
  await must("git", ["add", "-A"], { cwd: app });
  await must("git", ["-c", "user.name=acceptance", "-c", "user.email=acceptance@invalid", "commit", "-qm", "example"], { cwd: app });
  const root = await realpath(app);
  const bin = path.join(root, "node_modules/@azeajr/web-harness/bin/web-harness.mjs");
  return {
    root,
    bin,
    harness: (args, options = {}) => exec(process.execPath, [bin, ...args], { cwd: root, ...options }),
    spawnHarness: (args) => spawn(process.execPath, [bin, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }),
    readJson: async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8")),
    cleanup: () =>
      process.env.WEB_HARNESS_ACCEPTANCE_KEEP ? null : rm(base, { recursive: true, force: true }),
  };
}

// The last JSON object a structured command (run, observe, state) printed.
export function lastJson(stdout) {
  const line = stdout.trim().split("\n").reverse().find((text) => text.startsWith("{"));
  if (!line) throw new Error(`No JSON in output:\n${stdout.slice(-2000)}`);
  return JSON.parse(line);
}

export async function dockerIds(filter) {
  const { stdout } = await exec("docker", ["ps", "-aq", "--no-trunc", "--filter", filter]);
  return stdout.split("\n").filter(Boolean);
}

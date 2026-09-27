import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";

// web-harness mutate [stryker args...]
//
// Stryker with `inPlace: true` rewrites source files while it runs; interrupt it, or run it in a
// checkout someone else is using, and mutated code is left behind. Here it runs in a throwaway
// copy of the working tree (tracked + modified + untracked-not-ignored), installed offline from
// the store, so inPlace keeps its speed and loses its blast radius. Reports are copied back.
const exec = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (status, signal) =>
      status === 0 ? resolve() : reject(new Error(`${command} ${args[0]} failed (${status ?? signal}).`)),
    );
  });

function listFiles(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      ["ls-files", "--cached", "--modified", "--others", "--exclude-standard", "-z"],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
    );
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      status === 0
        ? resolve(Buffer.concat(chunks).toString("utf8").split("\0").filter(Boolean))
        : reject(new Error("Unable to enumerate the Git working tree.")),
    );
  });
}

export async function main(argv) {
  const config = await loadConfig();
  const mutate = {
    install:
      config.packageManager === "npm"
        ? ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"]
        : ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"],
    command: config.packageManager === "npm" ? ["npx", "stryker", "run"] : ["pnpm", "exec", "stryker", "run"],
    reports: ["reports/mutation"],
    ...config.mutate,
  };
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `wh-mutate-${config.name}-`));
  const workspace = path.join(temporaryRoot, "work");
  try {
    for (const relative of new Set(await listFiles(config.root))) {
      const source = path.join(config.root, relative);
      try {
        await access(source);
      } catch {
        continue;
      }
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await cp(source, path.join(workspace, relative), { force: true });
    }
    console.log(`Mutation workspace: ${workspace}`);
    await exec(mutate.install[0], mutate.install.slice(1), { cwd: workspace });
    let failure;
    try {
      await exec(mutate.command[0], [...mutate.command.slice(1), ...argv], { cwd: workspace });
    } catch (error) {
      failure = error; // a broken threshold still produces a report worth keeping
    }
    for (const report of mutate.reports) {
      const source = path.join(workspace, report);
      try {
        await access(source);
      } catch {
        continue;
      }
      await rm(path.join(config.root, report), { recursive: true, force: true });
      await mkdir(path.dirname(path.join(config.root, report)), { recursive: true });
      await cp(source, path.join(config.root, report), { recursive: true });
      console.log(`Report: ${path.join(config.root, report)}`);
    }
    if (failure) throw failure;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

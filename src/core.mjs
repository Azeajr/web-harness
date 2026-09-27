import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, open, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const IDENTITY_PATH = "/__web-harness/identity";
export const IDENTITY_META = "web-harness-server";

export const commands = [
  "preflight",
  "doctor",
  "start",
  "reset",
  "restart",
  "reload",
  "screenshot",
  "check",
  "status",
  "stop",
  "cli",
  "observe",
  "state",
  "run",
];
const baseValueOptions = [
  "session",
  "browser",
  "device",
  "url",
  "route",
  "fixture",
  "target",
  "setup",
  "workflow",
  "output",
  "port",
];
const flagOptions = new Set(["help", "full-page", "hires", "force-resources"]);

export function slug(value, label = "session") {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(value))
    throw new Error(`Invalid ${label}: use 1–48 lowercase letters, digits, or hyphens.`);
  return value;
}

// Adapter options (a chess PGN path, a colour) extend the value options. They may not shadow the
// controller's own options: a fixture cannot redefine what --port or --session mean.
export function parseArgs(input, { extraValueOptions = [] } = {}) {
  for (const name of extraValueOptions)
    if (baseValueOptions.includes(name) || flagOptions.has(name))
      throw new Error(`Adapter option --${name} shadows a controller option.`);
  const valueOptions = new Set([...baseValueOptions, ...extraValueOptions]);
  const args = [...input];
  if (args[0] === "--") args.shift();
  const options = {};
  const positional = [];
  let command;
  while (args.length) {
    const arg = args.shift();
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      if (flagOptions.has(key)) {
        if (rest.length) throw new Error(`--${key} does not take a value.`);
        options[key] = true;
      } else if (valueOptions.has(key)) {
        const value = rest.length ? rest.join("=") : args.shift();
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
        options[key] = value;
      } else throw new Error(`Unknown option: --${key}`);
    } else if (!command) {
      command = arg;
      if (!commands.includes(command)) throw new Error(`Unknown command: ${command}`);
      if (command === "cli") return { command, options, positional: args };
    } else positional.push(arg);
  }
  if (positional.length > (["screenshot", "observe", "run"].includes(command) ? 1 : 0))
    throw new Error("Unexpected positional arguments.");
  if (["observe", "run"].includes(command) && !positional.length && !options.help)
    throw new Error(
      `${command} requires ${command === "run" ? "a repository file" : "a locator selector"}.`,
    );
  if (options.target && !["dev", "production"].includes(options.target))
    throw new Error("--target must be dev or production.");
  if (options.target === "production" && options.url)
    throw new Error("--url attaches to an existing dev server; production targets are always owned.");
  return { command: command ?? "help", options, positional };
}

export function contained(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

// Resolve existing ancestors as well as lexical paths, including a not-yet-created output directory.
export async function resolvePath(root, value, { outside = false } = {}) {
  const target = path.resolve(root, value);
  let ancestor = target;
  const missing = [];
  for (;;) {
    try {
      const resolved = path.join(await realpath(ancestor), ...missing.reverse());
      if (resolved !== target) throw new Error(`Symlink paths are not supported: ${value}`);
      if (!outside && !contained(root, resolved))
        throw new Error(`Path must be inside the repository: ${value}`);
      if (resolved === root || resolved === path.parse(resolved).root)
        throw new Error("Output must be a dedicated subdirectory.");
      return resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export function targetUrl(value, route = "/") {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "--url must be a credential-free localhost or 127.0.0.1 HTTP(S) development server.",
    );
  }
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\"))
    throw new Error("--route must be a same-origin path starting with /.");
  const result = new URL(route, url);
  if (result.origin !== url.origin) throw new Error("--route must stay on the app origin.");
  return result.href;
}

export function reviewUrl(options, defaultPort) {
  if (options.url && options.port) throw new Error("Use --port or --url, not both.");
  const port = options.port ?? String(defaultPort);
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("--port must be an integer from 1024 to 65535.");
  return targetUrl(options.url ?? `http://127.0.0.1:${port}`, options.route);
}

// A lease outlives individual commands and is shared by every project and worktree for this
// host/user: ports are a host resource, so two different apps on one port must also collide.
// Even after a server dies, its browser must be closed before the port may be reused.
export function leasePath(url) {
  return path.join(
    os.tmpdir(),
    `web-harness-${process.getuid()}-port-${new URL(url).port}.lock`,
  );
}

export async function acquirePortLease(url, owner) {
  const filename = leasePath(url);
  const file = await open(filename, "wx", 0o600).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `Review port is reserved: ${filename}. Stop its recorded owner first. ${await readFile(filename, "utf8")}`,
    );
  });
  try {
    await file.writeFile(JSON.stringify(owner));
  } finally {
    await file.close();
  }
  return filename;
}

export async function releasePortLease(filename, token) {
  const owner = JSON.parse(await readFile(filename, "utf8"));
  if (owner.token !== token) throw new Error("Port lease ownership mismatch; refusing removal.");
  await unlink(filename);
}

export async function serverIdentity(url, expectedRoot, expectedToken) {
  const response = await fetch(new URL(IDENTITY_PATH, url), {
    signal: AbortSignal.timeout(2_000),
    cache: "no-store",
  });
  const identity = await response.json().catch(() => ({}));
  if (
    !response.ok ||
    identity.root !== expectedRoot ||
    typeof identity.token !== "string" ||
    !identity.token ||
    (expectedToken && identity.token !== expectedToken)
  )
    throw new Error(
      "Review server identity changed or belongs to another worktree. Stop/start to reseed.",
    );
  return identity;
}

export function deviceFor(devices, name, browser) {
  const descriptor = devices[name];
  if (!descriptor) throw new Error(`Unknown Playwright device: ${name}`);
  if (
    !["webkit", "chromium", "firefox"].includes(browser) ||
    descriptor.defaultBrowserType !== browser
  ) {
    throw new Error(
      `Device ${name} requires ${descriptor.defaultBrowserType}; choose a compatible --browser and --device explicitly.`,
    );
  }
  return descriptor;
}

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const imageFor = (version) => `mcr.microsoft.com/playwright:v${version}-noble`;

// Content identity of a build: every file's relative path and bytes, in a stable order. Two
// builds with the same digest serve the same bytes, whatever their timestamps.
export async function directoryDigest(directory) {
  const hash = createHash("sha256");
  const walk = async (relative) => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        const bytes = await readFile(path.join(directory, child));
        hash.update(`${child}\0${bytes.length}\0`);
        hash.update(bytes);
      } else throw new Error(`Build output contains a non-regular file: ${child}`);
    }
  };
  await walk("");
  return hash.digest("hex");
}

export function run(
  command,
  args,
  { cwd, timeout = 60_000, print = false, env = process.env } = {},
) {
  if (print) console.log([command, ...args.map((arg) => JSON.stringify(arg))].join(" "));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || timedOut)
        reject(
          new Error(
            `${command} ${args[0] ?? ""} ${timedOut ? "timed out" : `failed (${code})`}:\n${stderr || stdout}`,
          ),
        );
      else resolve(stdout.trim());
    });
  });
}

export function availablePort(url) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${target.port} is occupied or unavailable. Use --url only for a known development server, or stop its owner.`,
        ),
      ),
    );
    server.listen(Number(target.port), target.hostname, () => server.close(resolve));
  });
}

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid process PID.");
  try {
    const [stat, cmdline, cwd] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      realpath(`/proc/${pid}/cwd`),
    ]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return null;
    return { pid, startTicks: fields[19], cmdline, cwd };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

export function ownsProcess(record, actual, root, entry) {
  return Boolean(
    record &&
    actual &&
    record.pid === actual.pid &&
    record.startTicks === actual.startTicks &&
    actual.cwd === root &&
    actual.cmdline.split("\0").includes(entry),
  );
}

export const LABEL_ROOT = "web-harness.root";
export const LABEL_TOKEN = "web-harness.token";
export const LABEL_SESSION = "web-harness.session";

export function ownsContainer(manifest, info) {
  return Boolean(
    info &&
    info.Id === manifest.containerId &&
    info.Image === manifest.imageId &&
    info.Config?.Labels?.[LABEL_ROOT] === manifest.root &&
    info.Config?.Labels?.[LABEL_TOKEN] === manifest.token,
  );
}

export function resultJson(output) {
  // --raw returns the run-code result directly; never accept prose as a successful postcondition.
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`Playwright returned invalid structured output: ${output.slice(0, 500)}`);
  }
}

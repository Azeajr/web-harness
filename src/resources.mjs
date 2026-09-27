import { readFile } from "node:fs/promises";

// Headroom before a heavy run. A host with no swap does not OOM-kill one process under memory
// pressure: it stalls until it is rebooted. On 2026-09-27 a container E2E run and a native
// multi-worker run started side by side did exactly that to a 12 GB machine. Every command that
// starts a bounded container (a session's browser, a container E2E run) checks here first.

const GIB = 1024 ** 3;
const UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: GIB };

// Docker's size format: 3g, 512m, 1024k, 1073741824.
export function parseSize(value) {
  const match = /^(\d+(?:\.\d+)?)([bkmg])?$/i.exec(String(value).trim());
  if (!match) throw new Error(`Invalid size ${value}: use a number with an optional b, k, m or g.`);
  return Math.round(Number(match[1]) * UNITS[(match[2] ?? "b").toLowerCase()]);
}

export const formatSize = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

// /proc/meminfo, in bytes. Only the fields the budget reads.
export function parseMeminfo(text) {
  const field = (name) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, "m").exec(text);
    if (!match) throw new Error(`/proc/meminfo has no ${name}.`);
    return Number(match[1]) * 1024;
  };
  return {
    total: field("MemTotal"),
    available: field("MemAvailable"),
    swapTotal: field("SwapTotal"),
    swapFree: field("SwapFree"),
  };
}

// Without swap, pressure freezes the host instead of killing one process: keep more back.
export function marginFor(memory, env = process.env) {
  if (env.WEB_HARNESS_MEMORY_MARGIN) return parseSize(env.WEB_HARNESS_MEMORY_MARGIN);
  return memory.swapTotal > 0 ? 1.5 * GIB : 2.5 * GIB;
}

// Pure decision, exported for tests. A running harness container is already charged for what it
// uses (MemAvailable is lower by that much); what it may still grow into, up to its bound, is not.
// That growth is reserved, so two runs that each fit alone are refused together.
export function decideBudget({ memory, containers = [], need, margin }) {
  const reserved = containers.reduce(
    (sum, container) => sum + Math.max(0, container.limit - container.usage),
    0,
  );
  const usable = memory.available - reserved;
  return {
    ok: usable >= need + margin,
    available: memory.available,
    reserved,
    usable,
    need,
    margin,
    swap: memory.swapTotal,
    containers,
  };
}

export function describeBudget(budget, label) {
  const lines = [
    `${label}: needs ${formatSize(budget.need)} + ${formatSize(budget.margin)} margin; ` +
      `${formatSize(budget.usable)} usable (${formatSize(budget.available)} available, ` +
      `${formatSize(budget.reserved)} reserved by running harness containers).`,
  ];
  for (const container of budget.containers)
    lines.push(
      `  ${container.name}: bound ${formatSize(container.limit)}, using ${formatSize(container.usage)}` +
        (container.session ? ` — stop with: web-harness stop --session ${container.session}` : ""),
    );
  if (!budget.swap)
    lines.push("  No swap: memory pressure freezes this host instead of killing one process.");
  return lines.join("\n");
}

// Running containers the harness started: sessions carry the root label, E2E runs a name prefix.
// Usage comes from one `docker stats` sample; when that fails, the whole bound counts as reserved.
export async function harnessContainers(docker) {
  const ids = new Set();
  for (const filter of ["label=web-harness.root", "name=^wh-e2e-"])
    for (const id of (await docker(["ps", "-q", "--no-trunc", "--filter", filter])).split("\n"))
      if (id.trim()) ids.add(id.trim());
  if (!ids.size) return [];
  const usage = new Map();
  try {
    const stats = await docker([
      "stats",
      "--no-stream",
      "--no-trunc",
      "--format",
      "{{.ID}} {{.MemUsage}}",
      ...ids,
    ]);
    for (const line of stats.split("\n")) {
      const [id, used] = line.trim().split(/\s+/);
      if (id && used) usage.set(id, parseSize(used.replace(/i?B$/i, "").toLowerCase()));
    }
  } catch {
    /* charged in full below */
  }
  const containers = [];
  for (const info of JSON.parse(await docker(["inspect", ...ids]))) {
    const limit = info.HostConfig?.Memory || 0;
    containers.push({
      name: info.Name.replace(/^\//, ""),
      limit,
      usage: usage.get(info.Id) ?? 0,
      session: info.Config?.Labels?.["web-harness.session"] ?? null,
    });
  }
  return containers;
}

export async function readMemory() {
  return parseMeminfo(await readFile("/proc/meminfo", "utf8"));
}

// Check, and refuse unless forced. Returns the budget for the manifest either way.
export async function checkBudget({ docker, need, label, force = false, env = process.env }) {
  const memory = await readMemory();
  const budget = decideBudget({
    memory,
    containers: await harnessContainers(docker),
    need,
    margin: marginFor(memory, env),
  });
  budget.forced = Boolean(force && !budget.ok);
  if (!budget.ok && !force)
    throw new Error(
      `${describeBudget(budget, label)}\nNot enough memory headroom. Stop a running session or ` +
        `E2E run first, or pass --force-resources to proceed anyway.`,
    );
  return budget;
}

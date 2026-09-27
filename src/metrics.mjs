import { readFile } from "node:fs/promises";

// What a session costs the host, sampled at the end of each command: the browser container's
// peak memory (its cgroup's memory.peak, or the current usage from `docker stats` where the kernel
// has no peak counter) and the owned server's peak resident set (VmHWM), for its process and every
// descendant. Budgets come from measurements like these (design review section F), not from
// guesses; `web-harness bench` repeats a fixed sequence to collect them.

const UNITS = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 };

// "123.4MiB / 3GiB" → 129394278 (the usage side). Pure.
export function parseDockerMemory(text) {
  const match = /^\s*([\d.]+)\s*([kmg]?i?b)\b/i.exec(String(text));
  if (!match) return null;
  const unit = UNITS[match[2].toLowerCase()];
  return unit ? Math.round(Number(match[1]) * unit) : null;
}

// "VmHWM:	  123456 kB" in /proc/<pid>/status → 123456. Pure.
export function parseVmHwm(status) {
  const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(String(status));
  return match ? Number(match[1]) : null;
}

async function descendants(pid) {
  const found = [];
  const queue = [pid];
  while (queue.length && found.length < 64) {
    const current = queue.shift();
    const text = await readFile(`/proc/${current}/task/${current}/children`, "utf8").catch(() => "");
    for (const child of text.split(/\s+/).filter(Boolean).map(Number)) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

export async function serverPeak(pid) {
  if (!pid) return null;
  const own = parseVmHwm(await readFile(`/proc/${pid}/status`, "utf8").catch(() => ""));
  if (own === null) return null;
  let tree = own;
  for (const child of await descendants(pid))
    tree += parseVmHwm(await readFile(`/proc/${child}/status`, "utf8").catch(() => "")) ?? 0;
  return { pid, vmHwmKb: own, treeVmHwmKb: tree };
}

export async function containerPeak(docker, containerId) {
  if (!containerId) return null;
  try {
    const peak = Number((await docker(["exec", containerId, "cat", "/sys/fs/cgroup/memory.peak"], { timeout: 10_000 })).trim());
    if (Number.isFinite(peak) && peak > 0) return { bytes: peak, source: "memory.peak" };
  } catch {
    /* no cgroup v2 peak counter here */
  }
  try {
    const usage = await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", containerId], { timeout: 15_000 });
    const bytes = parseDockerMemory(usage);
    if (bytes !== null) return { bytes, source: "docker stats (current, not peak)" };
  } catch {
    /* container gone */
  }
  return null;
}

// Pure: median and 90th percentile (nearest rank) of a list of milliseconds.
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, median: null, p90: null, min: null, max: null };
  const rank = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  return { n: sorted.length, median, p90: rank(0.9), min: sorted[0], max: sorted.at(-1) };
}

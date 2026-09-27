import assert from "node:assert/strict";
import test from "node:test";
import { e2eArguments } from "../src/container.mjs";
import {
  checkBudget,
  decideBudget,
  describeBudget,
  harnessContainers,
  marginFor,
  parseMeminfo,
  parseSize,
} from "../src/resources.mjs";

const GIB = 1024 ** 3;
const meminfo = (availableGib, swapGib = 0) =>
  [
    `MemTotal:       ${12 * 1024 * 1024} kB`,
    `MemFree:        ${1024 * 1024} kB`,
    `MemAvailable:   ${availableGib * 1024 * 1024} kB`,
    `SwapTotal:      ${swapGib * 1024 * 1024} kB`,
    `SwapFree:       ${swapGib * 1024 * 1024} kB`,
  ].join("\n");

test("sizes and meminfo parse the way docker and the kernel write them", () => {
  assert.equal(parseSize("3g"), 3 * GIB);
  assert.equal(parseSize("512m"), 512 * 1024 ** 2);
  assert.equal(parseSize("1.5g"), 1.5 * GIB);
  assert.equal(parseSize("1073741824"), GIB);
  assert.throws(() => parseSize("lots"), /Invalid size/);
  const memory = parseMeminfo(meminfo(9, 0));
  assert.equal(memory.available, 9 * GIB);
  assert.equal(memory.swapTotal, 0);
  assert.throws(() => parseMeminfo("MemTotal: 1 kB"), /MemAvailable/);
});

test("no swap keeps a larger margin, and the environment can set it", () => {
  assert.equal(marginFor(parseMeminfo(meminfo(9, 0)), {}), 2.5 * GIB);
  assert.equal(marginFor(parseMeminfo(meminfo(9, 4)), {}), 1.5 * GIB);
  assert.equal(marginFor(parseMeminfo(meminfo(9, 0)), { WEB_HARNESS_MEMORY_MARGIN: "1g" }), GIB);
});

test("a run that fits alone is refused beside a container that may still grow into its bound", () => {
  const memory = parseMeminfo(meminfo(9, 0));
  const alone = decideBudget({ memory, need: 6 * GIB, margin: 2.5 * GIB });
  assert.equal(alone.ok, true);
  // The 2026-09-27 crash: a 6 GiB E2E container using 1 GiB could still take 5 GiB more.
  const running = [{ name: "wh-e2e-chess-1", limit: 6 * GIB, usage: GIB, session: null }];
  const beside = decideBudget({ memory, containers: running, need: 6 * GIB, margin: 2.5 * GIB });
  assert.equal(beside.ok, false);
  assert.equal(beside.reserved, 5 * GIB);
  const message = describeBudget(beside, "Container E2E");
  assert.match(message, /wh-e2e-chess-1: bound 6\.0 GiB/);
  assert.match(message, /No swap/);
  // A session container names the command that frees it.
  const session = [{ name: "wh-app-review-1", limit: 3 * GIB, usage: GIB, session: "review" }];
  assert.match(
    describeBudget(decideBudget({ memory, containers: session, need: GIB, margin: GIB }), "Session"),
    /web-harness stop --session review/,
  );
});

test("harness containers come from labels and the E2E name prefix, with sampled usage", async () => {
  const calls = [];
  const docker = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "ps" && args.includes("label=web-harness.root")) return "aaa\n";
    if (args[0] === "ps") return "bbb\n";
    if (args[0] === "stats") return "aaa 1.5GiB / 3GiB\nbbb 512MiB / 6GiB\n";
    return JSON.stringify([
      { Id: "aaa", Name: "/wh-app-review-1", HostConfig: { Memory: 3 * GIB }, Config: { Labels: { "web-harness.session": "review" } } },
      { Id: "bbb", Name: "/wh-e2e-app-9", HostConfig: { Memory: 6 * GIB }, Config: { Labels: {} } },
    ]);
  };
  const containers = await harnessContainers(docker);
  assert.deepEqual(containers, [
    { name: "wh-app-review-1", limit: 3 * GIB, usage: 1.5 * GIB, session: "review" },
    { name: "wh-e2e-app-9", limit: 6 * GIB, usage: 512 * 1024 ** 2, session: null },
  ]);
  // Unavailable stats charge the whole bound.
  const blind = await harnessContainers(async (args) => {
    if (args[0] === "stats") throw new Error("no stats");
    return docker(args);
  });
  assert.equal(blind[0].usage, 0);
  assert.deepEqual(await harnessContainers(async () => ""), []);
});

test("checkBudget refuses with the reason and proceeds only when forced", async () => {
  const docker = async () => "";
  // Ask for more than any host has, so the result does not depend on this machine.
  const need = 10_000 * GIB;
  await assert.rejects(
    checkBudget({ docker, need, label: "Session" }),
    /Not enough memory headroom[\s\S]*--force-resources/,
  );
  const forced = await checkBudget({ docker, need, label: "Session", force: true });
  assert.equal(forced.ok, false);
  assert.equal(forced.forced, true);
  const easy = await checkBudget({ docker, need: 1, label: "Session", env: { WEB_HARNESS_MEMORY_MARGIN: "1" } });
  assert.equal(easy.forced, false);
});

test("e2e passes every argument it does not own through to Playwright", () => {
  // Without --prebuilt the first Playwright argument used to be dropped (index -1 + 1 === 0).
  assert.deepEqual(e2eArguments(["tests/e2e/a.spec.ts", "--grep", "x"]).playwrightArgs, [
    "tests/e2e/a.spec.ts",
    "--grep",
    "x",
  ]);
  const parsed = e2eArguments(["--update-snapshots", "--prebuilt", "dist", "--force-resources", "-j", "2"]);
  assert.deepEqual(parsed, {
    updateSnapshots: true,
    forceResources: true,
    prebuilt: "dist",
    timezone: null,
    locale: null,
    playwrightArgs: ["-j", "2"],
  });
  const zoned = e2eArguments(["--timezone", "Pacific/Kiritimati", "--grep", "day", "--locale", "en-GB"]);
  assert.equal(zoned.timezone, "Pacific/Kiritimati");
  assert.equal(zoned.locale, "en-GB");
  assert.deepEqual(zoned.playwrightArgs, ["--grep", "day"]);
  assert.throws(() => e2eArguments(["--timezone"]), /--timezone needs a value/);
  assert.throws(() => e2eArguments(["--prebuilt"]), /needs a directory/);
  assert.throws(() => e2eArguments(["--prebuilt", "--grep"]), /needs a directory/);
});

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  open,
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  realpath,
  appendFile,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  IDENTITY_META,
  IDENTITY_PATH,
  LABEL_ROOT,
  LABEL_TOKEN,
  availablePort,
  acquirePortLease,
  releasePortLease,
  reviewUrl,
  serverIdentity,
  deviceFor,
  digest,
  directoryDigest,
  imageFor,
  ownsContainer,
  ownsProcess,
  parseArgs,
  processIdentity,
  resolvePath,
  resultJson,
  run,
  slug,
} from "./core.mjs";
import {
  STUB_EXTERNAL,
  consoleKind,
  describeConsole,
  failures,
  isExternal,
  isUnserved,
  isUnservedLoad,
} from "./faults.mjs";
import {
  applyFixture,
  installPolicy,
  scanClippedRegions,
  scanOverlayOverflow,
} from "./browser.mjs";
import { batchSource } from "./batch.mjs";
import { functionSource, loadConfig } from "./config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = await realpath(path.join(here, "server.mjs"));

// Separate worktrees and projects can each own a session, so bound every container the browser
// runs in. The session's server runs on the host, outside that bound, so cap its heap instead.
// This stays an argv entry: the PID, start time, cwd and entry that ownsProcess matches on are
// unchanged. It bounds the V8 heap only; esbuild and other children are not covered.
const containerMemory = process.env.WEB_HARNESS_DOCKER_MEMORY ?? "3g";
const containerCpus =
  process.env.WEB_HARNESS_DOCKER_CPUS ?? String(Math.min(2, availableParallelism()));
const serverHeapMb = process.env.WEB_HARNESS_SERVER_HEAP_MB ?? "1024";
if (!/^[1-9]\d{1,4}$/.test(serverHeapMb))
  throw new Error("WEB_HARNESS_SERVER_HEAP_MB must be a positive integer number of megabytes.");

// A native dialog/file-chooser blocks Playwright's run-code tool until something resolves it
// (dialog-accept/dismiss, upload, ...). That is a normal, recoverable UI state — not lost server
// continuity — so callers must not let it fail health() or overwrite retained fault evidence.
const isModalBusy = (error) => /does not handle the modal state/i.test(error.message);

// Page-side helpers shipped with every run-code that classifies faults.
const faultLib = `{ consoleKind: ${consoleKind}, describeConsole: ${describeConsole}, isExternal: ${isExternal}, isUnserved: ${isUnserved}, isUnservedLoad: ${isUnservedLoad}, failures: ${failures}, STUB_EXTERNAL: ${JSON.stringify(STUB_EXTERNAL)} }`;

export async function main(argv) {
  const config = await loadConfig();
  const root = config.root;
  const require = createRequire(path.join(config.playwrightFrom, "package.json"));
  const { devices } = require("playwright");
  const version = require("playwright/package.json").version;
  const cliEntry = await realpath(
    path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js"),
  );
  const docker = (args, options = {}) => run("docker", args, { cwd: root, ...options });
  let manifest;
  let manifestPath;
  let lockPath;
  let creating = false;
  let interrupted = false;
  let structuredOutput = false;
  const commandStarted = performance.now();
  const transport = { calls: 0, ms: 0 };
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      interrupted = true;
    });
  const assertRunning = () => {
    if (interrupted) throw new Error("Harness command interrupted.");
  };

  function help() {
    const fixtures = Object.entries(config.fixtures)
      .map(([name, fixture]) => `  ${name.padEnd(16)}${fixture.description ?? ""}`)
      .join("\n");
    console.log(`Docker-based agent harness for ${config.name} (Linux; local Playwright ${version}).
Usage: web-harness [--session NAME] <command> [options]
  preflight|doctor  Check Docker/image/device launch, config and port; never installs or pulls
  start           Start owned server + container, apply fixture, snapshot, screenshot, check faults
  reload          Reload the page in the same browser profile (same document, same storage)
  restart         Close and reopen the browser on the SAME persistent profile (durability proof)
  reset           Recreate the browser profile and replay the same fixture in a new run directory
  screenshot LABEL [--full-page] [--hires]  Save a numbered PNG at a printed absolute host path
  check           Retain/write faults.json; exit 1 for runtime, network or layout faults
  status          Print ownership, artifacts, and next commands
  stop            Close session and remove only owned container/server; retain artifacts
  cli <args...>   Run arbitrary Playwright CLI commands inside the owned session
  observe SELECTOR  Inspect a targeted region as compact JSON (up to five matches)
  state           Read the app's development state accessor as compact JSON (dev target only)
  run REPO_FILE   Batch trusted async (page, {step, assert, observe, state}) => {...}; JSON result

Start/preflight: --target dev|production (default dev) --fixture NAME
  --browser ${config.defaults.browser} --device "${config.defaults.device}"
  --port PORT (default ${config.port}; use distinct ports for concurrent sessions)
  --url URL (dev only: identity-verified existing localhost server; never stopped) --route /
  --setup REPO_FILE (trusted async page => {...} returning JSON postconditions)
  --workflow SLUG --output DIRECTORY (default .web-harness; repeat for later commands)${config.options.length ? `\n  Project options: ${config.options.map((name) => `--${name}`).join(" ")}` : ""}
Fixtures:
${fixtures}
Reset refuses changed fixture/setup digests; use stop/start to establish a changed baseline.
No host browser, no silent browser fallback. Exit 0: success; exit 1: invalid input, failed
preflight, fault, ownership, or cleanup check.
Guide: https://github.com/Azeajr/web-harness/blob/main/docs/HARNESS.md`);
  }

  async function save() {
    await writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2) + "\n");
    await rename(`${manifestPath}.tmp`, manifestPath);
  }

  async function event(kind, detail = {}) {
    await appendFile(
      path.join(path.dirname(manifestPath), "events.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), kind, runId: manifest.runId, ...detail }) +
        "\n",
    );
  }

  async function health({ browser = true } = {}) {
    try {
      if (!manifest.identity) throw new Error("Session has no server identity. Stop/start.");
      if (manifest.status === "infrastructure-failed")
        throw new Error("Session lost server continuity. Stop/start to reseed.");
      if (
        manifest.server &&
        !ownsProcess(manifest.server, await processIdentity(manifest.server.pid), root, serverEntry)
      )
        throw new Error("Owned server is no longer running. Stop/start to reseed.");
      await serverIdentity(manifest.seed.url, root, manifest.identity.token);
      if (browser) {
        let identity;
        try {
          identity = await code(
            async (page, meta) => ({
              token:
                meta === null
                  ? null
                  : await page
                      .locator(`meta[name="${meta}"]`)
                      .getAttribute("content", { timeout: 2_000 }),
              url: page.url(),
            }),
            // A production build carries no identity meta tag (it would ship); the server
            // identity above and the page origin below are the proof there.
            manifest.target === "dev" ? IDENTITY_META : null,
          );
        } catch (error) {
          if (isModalBusy(error)) {
            await event("health-deferred", { message: error.message });
            return;
          }
          throw error;
        }
        if (
          (manifest.target === "dev" && identity.token !== manifest.identity.token) ||
          new URL(identity.url).origin !== new URL(manifest.seed.url).origin
        )
          throw new Error("Browser is attached to a different server. Stop/start to reseed.");
      }
    } catch (error) {
      manifest.status = "infrastructure-failed";
      manifest.infrastructureFaults ??= [];
      manifest.infrastructureFaults.push({
        at: new Date().toISOString(),
        kind: "infrastructure",
        detail: error.message,
      });
      await event("health-failed", { message: error.message });
      await save();
      throw error;
    }
  }

  async function inspectContainer() {
    const all = JSON.parse(
      await docker(["ps", "-a", "--no-trunc", "--format", "{{json .ID}}"]).then(
        (output) => `[${output.split("\n").filter(Boolean).join(",")}]`,
      ),
    );
    if (!all.includes(manifest.containerId)) return null;
    const info = JSON.parse(await docker(["inspect", manifest.containerId]))[0];
    if (!ownsContainer(manifest, info))
      throw new Error("Container ownership mismatch; refusing to use or remove it.");
    return info;
  }

  async function cli(args, { raw = false } = {}) {
    const started = performance.now();
    transport.calls++;
    try {
      assertRunning();
      const info = await inspectContainer();
      if (!info?.State.Running)
        throw new Error("Owned review container is not running. Use stop, then start.");
      const output = await docker(
        [
          "exec",
          "-w",
          path.dirname(manifest.runDir),
          manifest.containerId,
          "node",
          cliEntry,
          "cli",
          `-s=${manifest.session}`,
          ...(raw ? ["--raw"] : []),
          ...args,
        ],
        { print: !structuredOutput, timeout: 180_000 },
      );
      // CLI tools may report an error while the transport itself exits successfully.
      if (/^### Error\b/m.test(output)) throw new Error(output);
      return raw ? resultJson(output) : output;
    } finally {
      transport.ms += performance.now() - started;
    }
  }

  // Serialize a function (plus an optional helper-object source) into a run-code file.
  async function code(fn, arg, lib = "undefined") {
    const filename = path.join(manifest.runDir, `command-${randomUUID()}.js`);
    await writeFile(
      filename,
      `async page => (${fn.toString()})(page, ${JSON.stringify(arg ?? null)}, ${lib})`,
    );
    return cli(["run-code", `--filename=${filename}`], { raw: true });
  }

  const stateSpec = () =>
    `{ sections: ${JSON.stringify(config.state.sections)}, defaults: ${JSON.stringify(config.state.defaults)}, target: ${JSON.stringify(manifest.target)}, read: ${config.state.read ? functionSource(config.state.read, "state.read") : "null"} }`;

  async function structuredCommand(command, positional) {
    const id = `batch-${randomUUID()}`;
    const base = path.join(manifest.runDir, id);
    const sourcePath = command === "run" ? await resolvePath(root, positional[0]) : null;
    const source = sourcePath
      ? await readFile(sourcePath, "utf8")
      : command === "observe"
        ? `async (page, { observe }) => observe(${JSON.stringify(positional[0])})`
        : "async (page, { state }) => state()";
    const wrapped = batchSource(source, base, { stateSpec: stateSpec(), policy: config.policy });
    await writeFile(`${base}.source.js`, source);
    await writeFile(`${base}.js`, wrapped);
    let report;
    try {
      report = await cli(["run-code", `--filename=${base}.js`], { raw: true });
      await health();
    } catch (error) {
      // Transport/server failures must remain failures even when browser-side work succeeded.
      report = {
        ...report,
        ok: false,
        error: report?.error ?? error.message,
        controllerError: error.message,
      };
    }
    if (!report.ok) {
      try {
        await check({ throwOnFault: false });
        report.faultsReport = path.join(manifest.runDir, "faults.json");
      } catch (error) {
        report.diagnosticsError = error.message;
      }
    }
    report = {
      ...report,
      runId: manifest.runId,
      target: manifest.target,
      source: sourcePath,
      sourceDigest: digest(source),
      report: `${base}.json`,
      timing: {
        totalMs: Math.round(performance.now() - commandStarted),
        transportCalls: transport.calls,
        transportMs: Math.round(transport.ms),
      },
    };
    await writeFile(`${base}.json`, JSON.stringify(report, null, 2) + "\n");
    await event("batch-completed", {
      command,
      ok: report.ok,
      report: report.report,
      timing: report.timing,
    });
    const output = JSON.stringify(report);
    console.log(
      output.length <= 16000
        ? output
        : JSON.stringify({
            ok: report.ok,
            error: report.error,
            runId: report.runId,
            report: report.report,
            timing: report.timing,
            outputTruncated: true,
            screenshot: report.artifacts?.screenshot ?? null,
          }),
    );
    if (!report.ok) process.exitCode = 1;
  }

  async function prepareFixture(options) {
    const target = options.target ?? "dev";
    if (target === "production" && !config.production)
      throw new Error("This project configures no production target.");
    const name = slug(options.fixture ?? config.defaultFixture, "fixture");
    const fixture = config.fixtures[name];
    if (!fixture)
      throw new Error(
        `Unknown fixture ${name}. Registered: ${Object.keys(config.fixtures).join(", ")}.`,
      );
    const setupPath = options.setup ? await resolvePath(root, options.setup) : null;
    const setup = setupPath ? await readFile(setupPath, "utf8") : null;
    const projectOptions = Object.fromEntries(
      config.options.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
    );
    const data = fixture.prepare
      ? await fixture.prepare({
          root,
          options: projectOptions,
          resolve: (value) => resolvePath(root, value),
        })
      : null;
    const seed = {
      fixture: name,
      target,
      data: data ?? null,
      options: projectOptions,
      setupPath,
      setup,
      url: reviewUrl(options, config.port),
      // The page-side code is part of what the fixture IS: an edited apply function is a
      // different baseline, and reset must refuse it just as it refuses changed data.
      apply: fixture.apply ? functionSource(fixture.apply, `fixtures.${name}.apply`) : null,
    };
    JSON.stringify(seed.data); // fixture data must survive the trip into run-code
    return { ...seed, digest: digest(JSON.stringify(seed)) };
  }

  async function probeUrl(url, target) {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const html = await response.text();
    if (!response.ok) throw new Error(`No app at ${url}: HTTP ${response.status}.`);
    if (target === "dev" && !html.includes(config.dev.marker))
      throw new Error(
        `No ${config.name} development server at ${url} (missing ${config.dev.marker}).`,
      );
    if (target === "production" && html.includes("/@vite/client"))
      throw new Error(`${url} serves a development build, not the production target.`);
  }

  async function preflight(options, { checkPort = true } = {}) {
    if (process.platform !== "linux")
      throw new Error(
        "This controller requires Linux Docker host networking and /proc ownership checks.",
      );
    const browser = options.browser ?? config.defaults.browser;
    const device = options.device ?? config.defaults.device;
    const descriptor = deviceFor(devices, device, browser);
    await docker(["info", "--format", "{{.ServerVersion}}"]);
    const image = imageFor(version);
    let imageId;
    try {
      imageId = await docker(["image", "inspect", image, "--format", "{{.Id}}"]);
    } catch {
      throw new Error(
        `Matching Playwright image is unavailable. Provision it with: docker pull ${image}`,
      );
    }
    const probeName = `wh-probe-${randomUUID()}`;
    try {
      await docker([
        "run",
        "--rm",
        "--init",
        "--memory",
        containerMemory,
        "--memory-swap",
        containerMemory,
        "--cpus",
        containerCpus,
        "--name",
        probeName,
        "--network",
        "host",
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "-e",
        "HOME=/tmp",
        "-v",
        `${root}:${root}:ro`,
        "-w",
        "/tmp",
        imageId,
        "node",
        "--input-type=module",
        "-e",
        `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(path.join(config.playwrightFrom, "package.json"))});
      const pw=require('playwright'); const b=await pw[${JSON.stringify(browser)}].launch();
      try { const c=await b.newContext(pw.devices[${JSON.stringify(device)}]); await c.newPage(); } finally { await b.close(); }`,
      ]);
    } finally {
      // --rm normally removed it; inspect exact unique probe name before cleanup on timeout.
      const ids = await docker(["ps", "-aq", "--filter", `name=^/${probeName}$`]);
      if (ids) await docker(["rm", "--force", ids]);
    }
    if (checkPort) {
      if (options.url) {
        await probeUrl(reviewUrl(options, config.port), "dev");
        await serverIdentity(reviewUrl(options, config.port), root);
      } else await availablePort(reviewUrl(options, config.port));
    }
    const report = {
      project: config.name,
      node: process.version,
      playwright: version,
      image,
      imageId,
      browser,
      device,
      descriptor,
      targets: ["dev", ...(config.production ? ["production"] : [])],
      fixtures: Object.keys(config.fixtures),
      stateSections: config.state.sections,
    };
    console.log(JSON.stringify(report, null, 2));
    return { image, imageId, browser, device, descriptor };
  }

  // Build once per session into a session-owned directory: the repository's own dist/ is not
  // touched, and the digest names exactly which bytes this session reviewed.
  async function buildProduction(directory) {
    const outDir = path.join(directory, "build");
    await rm(outDir, { recursive: true, force: true });
    const logPath = path.join(manifest.runDir, "build.log");
    const log = await open(logPath, "a");
    const [command, ...args] = config.production.build(outDir);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
          cwd: path.resolve(root, config.production.cwd),
          stdio: ["ignore", log.fd, log.fd],
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
        child.once("error", reject);
        child.once("close", (status) => {
          clearTimeout(timer);
          if (status === 0) resolve();
          else reject(new Error(`Production build failed (${status}). See ${logPath}`));
        });
      });
    } finally {
      await log.close();
    }
    manifest.build = { outDir, digest: await directoryDigest(outDir) };
    await event("build-completed", manifest.build);
    await save();
  }

  async function startServer() {
    const log = await open(path.join(manifest.runDir, "server.log"), "a");
    const port = new URL(manifest.seed.url).port;
    const env = {
      ...process.env,
      WEB_HARNESS_PORT: port,
      WEB_HARNESS_TOKEN: manifest.token,
      WEB_HARNESS_ROOT: root,
      WEB_HARNESS_TARGET: manifest.target,
      WEB_HARNESS_EVENTS: path.join(path.dirname(manifestPath), "events.jsonl"),
    };
    if (manifest.target === "production") {
      env.WEB_HARNESS_SERVE_DIR = manifest.build.outDir;
      env.WEB_HARNESS_UNSERVED = JSON.stringify(config.policy.unservedPrefixes);
    } else {
      env.WEB_HARNESS_COMMAND = JSON.stringify(config.dev.command(Number(port)));
      env.WEB_HARNESS_CWD = path.resolve(root, config.dev.cwd);
    }
    const child = spawn(process.execPath, [`--max-old-space-size=${serverHeapMb}`, serverEntry], {
      cwd: root,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    await log.close();
    manifest.server = await processIdentity(child.pid);
    await save();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      assertRunning();
      if (!(await processIdentity(child.pid))) break;
      try {
        await probeUrl(manifest.seed.url, manifest.target);
        manifest.identity = await serverIdentity(manifest.seed.url, root, manifest.token);
        await event("server-ready", { server: manifest.server, identity: manifest.identity });
        await save();
        return;
      } catch {
        await delay(200);
      }
    }
    throw new Error(
      `Server did not become ready. See ${path.join(manifest.runDir, "server.log")}`,
    );
  }

  async function newRun() {
    manifest.runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    manifest.runDir = await resolvePath(
      root,
      path.join(manifest.output, manifest.session, manifest.runId),
      { outside: true },
    );
    manifest.sequence = 0;
    await mkdir(manifest.runDir, { recursive: true });
    await writeFile(
      path.join(manifest.runDir, "review.md"),
      `# ${manifest.workflow}\n\nProject: ${config.name}\nRun: ${manifest.runId}\nTarget: ${manifest.target}\nFixture: ${manifest.seed.fixture} (${manifest.seed.digest})\n\nWorkflow is an artifact label, not an executed journey. See docs/HARNESS.md for completion requirements.\n\n## Goal and terminal acceptance\nNot yet recorded.\n\n## Attempts and evidence\nList ALL attempts (including failures), run IDs, check timestamps, CLI errors, warnings, and missing artifacts. faults.json covers only its recorded time.\n\n## Observations\nRecord visible controls, scoped roles, before/after state, running AND terminal state, inspected PNGs, and document continuity.\n\n## Verdict and remaining coverage\nNot yet reviewed. Zero faults does not establish workflow completion or error-path coverage.\n`,
    );
    await save();
  }

  async function screenshot(label, options = {}) {
    slug(label, "screenshot label");
    const number = String(manifest.sequence++).padStart(2, "0");
    const target = path.join(
      manifest.runDir,
      `${number}-${label}${options["full-page"] ? "-full-page" : ""}.png`,
    );
    console.log(
      await cli([
        "screenshot",
        `--filename=${target}`,
        ...(options["full-page"] ? ["--full-page"] : []),
        ...(options.hires ? ["--hires"] : []),
      ]),
    );
    if (options["full-page"]) for (const line of await clippedRegions()) console.log(line);
    await save();
    console.log(`Inspect image: ${target}`);
  }

  async function clippedRegions() {
    let found;
    try {
      found = await code(scanClippedRegions);
    } catch (error) {
      // A capture must never fail because the advisory scan could not run.
      return [`Could not scan for internally scrolled regions: ${error.message}`];
    }
    if (!found.length) return [];
    return [
      `Full-page capture omits ${found.length} internally scrolled region(s); scroll each and capture it separately:`,
      ...found.map(
        (region) => `  "${region.name}" shows ${region.shown}px, ${region.hidden}px stay offscreen.`,
      ),
    ];
  }

  async function check({ throwOnFault = true } = {}) {
    let collected;
    let deferred = false;
    try {
      collected = await code(
        async (page, _arg, scanOverflow) => ({
          records: page.context().__webHarnessFaults,
          warnings: page.context().__webHarnessWarnings ?? [],
          overflow: await scanOverflow(page),
        }),
        null,
        scanOverlayOverflow.toString(),
      );
    } catch (error) {
      collected = { records: [], warnings: [] };
      // Never overwrite retained browser evidence just because its container disappeared.
      try {
        const prior = JSON.parse(await readFile(path.join(manifest.runDir, "faults.json"), "utf8"));
        collected = { records: prior.live ?? [], warnings: prior.warnings ?? [] };
      } catch {
        /* no prior check */
      }
      if (isModalBusy(error)) {
        // A pending native dialog/chooser blocks in-page inspection; this is not a new fault, and
        // resolving it (dialog-accept/dismiss, upload, ...) is the caller's very next move.
        deferred = true;
      } else {
        collected.records.push({ kind: "infrastructure", detail: error.message });
      }
    }
    const overflowRecords = (collected.overflow ?? []).map((item) => ({
      kind: "layout-overflow",
      detail:
        `${item.role} "${item.name}" renders outside the ${item.viewport.width}x${item.viewport.height} ` +
        `viewport (edges left=${item.rect.left} top=${item.rect.top} right=${item.rect.right} bottom=${item.rect.bottom}).`,
    }));
    const records = [
      // Faults from browser lifetimes that `restart` closed. A restart must not launder them.
      ...(manifest.retainedFaults ?? []),
      ...(collected.records ?? []),
      ...overflowRecords,
      ...(manifest.infrastructureFaults ?? []),
    ];
    const faults = failures(records, config.policy);
    const report = path.join(manifest.runDir, "faults.json");
    await writeFile(
      report,
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          runId: manifest.runId,
          target: manifest.target,
          records,
          faults,
          // This browser lifetime's own records, so a later fallback read does not double-count
          // the retained ones.
          live: collected.records ?? [],
          warnings: collected.warnings ?? [],
        },
        null,
        2,
      ) + "\n",
    );
    if (deferred && !structuredOutput)
      console.log(
        "A native dialog/chooser is open; resolve it, then re-run check for a fresh read.",
      );
    if (!structuredOutput)
      console.log(
        `${faults.length} fault(s), ${collected.warnings?.length ?? 0} warning(s): ${report}`,
      );
    if (faults.length && throwOnFault)
      throw new Error(faults.map((fault) => `${fault.kind}: ${fault.detail}`).join("\n"));
    return { records: collected.records ?? [], faults };
  }

  // Open the session's browser on its persistent profile and install the fault policy before any
  // app request, including first boot.
  async function openBrowser() {
    console.log(
      await cli([
        "open",
        "about:blank",
        `--browser=${manifest.browser}`,
        `--device=${manifest.device}`,
        `--profile=${manifest.profileDir}`,
      ]),
    );
    await health({ browser: false });
    await code(
      installPolicy,
      {
        origin: new URL(manifest.seed.url).origin,
        identityUrl: new URL(IDENTITY_PATH, manifest.seed.url).href,
        identity: manifest.identity,
        policy: config.policy,
        initScript: config.initScript ? functionSource(config.initScript, "initScript") : null,
      },
      faultLib,
    );
  }

  const readyLib = () =>
    `{ ready: ${config.ready ? functionSource(config.ready, "ready") : "null"}, apply: ${manifest.seed.apply ?? "null"} }`;

  async function initialize() {
    await openBrowser();
    // Fixture data also lands as a file in the run directory, which the container mounts: a
    // fixture that restores a backup through a file input needs a path (run-code has no Buffer).
    // A `file` property, when present, is the file's whole content (a backup to import);
    // otherwise the file holds all of the data.
    const dataFile = path.join(manifest.runDir, "fixture-data.json");
    const data = manifest.seed.data;
    await writeFile(dataFile, JSON.stringify(data?.file ?? data ?? null, null, 2));
    manifest.postconditions = await code(
      applyFixture,
      { url: manifest.seed.url, data: manifest.seed.data, dataFile },
      readyLib(),
    );
    // Apps route after setup (a wizard lands on /today); the proof is that the browser is still
    // on the owned server, not that it never navigated.
    if (new URL(manifest.postconditions.url).origin !== new URL(manifest.seed.url).origin)
      throw new Error(
        `Fixture left the app origin: expected ${new URL(manifest.seed.url).origin}, at ${manifest.postconditions.url}.`,
      );
    if (manifest.seed.setup) {
      const setupFile = path.join(manifest.runDir, "setup.js");
      await writeFile(setupFile, manifest.seed.setup);
      manifest.setupPostconditions = await cli(["run-code", `--filename=${setupFile}`], {
        raw: true,
      });
    }
    await check(); // Fixture faults must not disappear at the log boundary.
    await cli(["console", "--clear"]);
    await cli(["requests", "--clear"]);
    console.log(
      await cli([
        "snapshot",
        "--depth=6",
        "--boxes",
        `--filename=${path.join(manifest.runDir, "00-seeded.yml")}`,
      ]),
    );
    await screenshot("seeded", { hires: true });
    manifest.source = {
      commit: await run("git", ["rev-parse", "HEAD"], { cwd: root }).catch(() => null),
      worktree: await run("git", ["status", "--short"], { cwd: root }).catch(() => null),
    };
    manifest.status = "ready";
    await save();
    await writeFile(
      path.join(manifest.runDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    await check();
  }

  // Close the browser and reopen it on the same profile directory: storage, OPFS, IndexedDB,
  // caches and the service worker registration survive; in-memory state and the fault collector
  // do not. Faults from the closed lifetime are retained in the manifest first.
  async function restart() {
    const before = await check({ throwOnFault: false });
    manifest.retainedFaults = [...(manifest.retainedFaults ?? []), ...before.records];
    await event("restart-requested", { retained: before.records.length });
    await cli(["close"]);
    manifest.status = "restarting";
    manifest.restarts = (manifest.restarts ?? 0) + 1;
    await save();
    await openBrowser();
    manifest.postconditions = await code(
      applyFixture,
      { url: manifest.seed.url, data: null },
      `{ ready: ${config.ready ? functionSource(config.ready, "ready") : "null"}, apply: null }`,
    );
    manifest.status = "ready";
    await save();
    await screenshot(`restart-${manifest.restarts}`);
    await check();
  }

  async function reload() {
    await code(
      async (page, _arg, lib) => {
        await page.reload({ waitUntil: "domcontentloaded" });
        if (lib.ready) await lib.ready(page);
        return page.url();
      },
      null,
      `{ ready: ${config.ready ? functionSource(config.ready, "ready") : "null"} }`,
    );
    await check();
  }

  async function cleanup() {
    await event("stop-requested", { server: manifest.server });
    const errors = [];
    if (manifest.containerId) {
      try {
        const info = await inspectContainer();
        if (info) {
          if (info.State.Running && !interrupted) {
            await cli(["close"]).catch((error) => console.error(error.message));
            await cli(["delete-data"]).catch((error) => console.error(error.message));
          }
          await docker(["rm", "--force", manifest.containerId]);
        }
        manifest.containerId = null;
      } catch (error) {
        errors.push(error.message);
      }
    }
    // Do not release the server/port if the owned browser could not be closed.
    if (manifest.server && !errors.length) {
      try {
        const actual = await processIdentity(manifest.server.pid);
        if (actual) {
          if (!ownsProcess(manifest.server, actual, root, serverEntry))
            throw new Error("Server process ownership mismatch; refusing to stop it.");
          process.kill(-actual.pid, "SIGTERM");
          const deadline = Date.now() + 5_000;
          while ((await processIdentity(actual.pid)) && Date.now() < deadline) await delay(100);
          const remaining = await processIdentity(actual.pid);
          if (remaining && ownsProcess(manifest.server, remaining, root, serverEntry))
            process.kill(-actual.pid, "SIGKILL");
        }
        manifest.server = null;
      } catch (error) {
        errors.push(error.message);
      }
    }
    if (manifest.portLease && !errors.length) {
      try {
        await releasePortLease(manifest.portLease, manifest.token);
        manifest.portLease = null;
      } catch (error) {
        errors.push(error.message);
      }
    }
    manifest.status = errors.length ? "cleanup-failed" : "stopped";
    await save();
    await event("cleanup", { status: manifest.status, errors });
    if (errors.length) throw new Error(errors.join("\n"));
  }

  async function commandMain() {
    const { command, options, positional } = parseArgs(argv, {
      extraValueOptions: config.options,
    });
    structuredOutput = ["run", "observe", "state"].includes(command);
    if (command === "help" || options.help) return help();
    const session = slug(options.session ?? config.name);
    const output = await resolvePath(root, options.output ?? ".web-harness", {
      outside: Boolean(options.output),
    });
    if (command === "preflight" || command === "doctor") return preflight(options);
    const directory = await resolvePath(root, path.join(output, session), { outside: true });
    await mkdir(directory, { recursive: true });
    manifestPath = path.join(directory, "session.json");
    const pendingLock = path.join(directory, "command.lock");
    const lock = await open(pendingLock, "wx").catch(() => {
      throw new Error(
        `Session command lock exists: ${pendingLock}. Check its recorded PID before removing a stale lock.`,
      );
    });
    lockPath = pendingLock;
    await lock.writeFile(JSON.stringify(await processIdentity(process.pid)));
    await lock.close();
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      manifest &&
      (manifest.root !== root ||
        manifest.session !== session ||
        manifest.output !== output ||
        manifest.project !== config.name ||
        manifest.schema !== 2)
    )
      throw new Error("Invalid session manifest ownership.");
    if (command === "start") {
      if (manifest && manifest.status !== "stopped")
        throw new Error("Session already exists. Use status, reset, or stop before start.");
      const seed = await prepareFixture(options);
      const environment = await preflight(options);
      assertRunning();
      manifest = {
        schema: 2,
        project: config.name,
        root,
        session,
        output,
        token: randomUUID(),
        target: seed.target,
        ...environment,
        seed,
        options,
        workflow: slug(options.workflow ?? "review", "workflow"),
        status: "starting",
        server: null,
        containerId: null,
        profileDir: path.join(directory, "profile"),
        retainedFaults: [],
      };
      creating = true;
      await rm(manifest.profileDir, { recursive: true, force: true });
      await newRun();
      if (!options.url) {
        manifest.portLease = await acquirePortLease(seed.url, {
          token: manifest.token,
          root,
          project: config.name,
          session,
          manifestPath,
        });
        await save();
        if (manifest.target === "production") await buildProduction(directory);
        await startServer();
      } else {
        manifest.identity = await serverIdentity(seed.url, root);
        await save();
      }
      assertRunning();
      manifest.containerId = await docker([
        "create",
        "--init",
        "--network",
        "host",
        "--ipc=host",
        "--memory",
        containerMemory,
        // Equal swap disables swap for the container: Docker otherwise grants twice the memory bound.
        "--memory-swap",
        containerMemory,
        "--cpus",
        containerCpus,
        "--name",
        `wh-${config.name}-${session}-${manifest.token.slice(0, 8)}`,
        "--label",
        `${LABEL_ROOT}=${root}`,
        "--label",
        `${LABEL_TOKEN}=${manifest.token}`,
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "-e",
        "HOME=/tmp",
        "-v",
        `${root}:${root}:ro`,
        "-v",
        `${directory}:${directory}:rw`,
        "-w",
        directory,
        manifest.imageId,
        "sleep",
        "infinity",
      ]);
      await save();
      await docker(["start", manifest.containerId]);
      await initialize();
      creating = false;
      return;
    }
    if (!manifest) {
      if (["status", "stop"].includes(command)) {
        console.log(`No session ${session}. Next: web-harness start`);
        return;
      }
      throw new Error("No session manifest. Run start first.");
    }
    // A manipulated manifest may not redirect writes outside this session artifact directory.
    if (
      manifest.runDir !== path.join(directory, manifest.runId) ||
      !/^[\da-zA-Z-]+$/.test(manifest.runId) ||
      manifest.profileDir !== path.join(directory, "profile")
    )
      throw new Error("Invalid run directory in manifest.");
    await resolvePath(root, manifest.runDir, { outside: true });
    if (command === "stop") {
      if (manifest.status !== "stopped") {
        await health().catch(() => {});
        await check({ throwOnFault: false });
      }
      return cleanup();
    }
    if (command === "status") {
      if (!["stopped", "infrastructure-failed", "cleanup-failed"].includes(manifest.status)) {
        await health({ browser: false }).catch(async () => check({ throwOnFault: false }));
      }
      console.log(
        JSON.stringify(
          {
            status: manifest.status,
            target: manifest.target,
            fixture: manifest.seed.fixture,
            build: manifest.build ?? null,
            container: manifest.containerId
              ? ((await inspectContainer())?.State.Status ?? "missing")
              : "none",
            serverOwned: Boolean(manifest.server),
            serverAlive: manifest.server
              ? ownsProcess(
                  manifest.server,
                  await processIdentity(manifest.server.pid),
                  root,
                  serverEntry,
                )
              : null,
            runDir: manifest.runDir,
            seed: manifest.seed.digest,
            identity: manifest.identity,
            restarts: manifest.restarts ?? 0,
            infrastructureFaults: manifest.infrastructureFaults ?? [],
          },
          null,
          2,
        ),
      );
      console.log(
        "Next: web-harness cli snapshot | run FILE | screenshot <label> | check | reload | restart | reset | stop",
      );
      return;
    }
    try {
      await health();
    } catch (error) {
      await check({ throwOnFault: false });
      throw error;
    }
    await event("command", { command, args: positional });
    if (structuredOutput) return structuredCommand(command, positional);
    if (command === "reset") {
      const seed = await prepareFixture(manifest.options);
      if (seed.digest !== manifest.seed.digest)
        throw new Error(
          "Fixture/setup changed. Stop/start to establish a new baseline; reset requires the same digest.",
        );
      await check({ throwOnFault: false }); // Preserve the prior fault report before replaying a fix.
      await event("reset-requested");
      await cli(["close"]);
      await cli(["delete-data"]);
      await rm(manifest.profileDir, { recursive: true, force: true });
      manifest.retainedFaults = [];
      manifest.restarts = 0;
      await newRun();
      manifest.status = "resetting";
      await save();
      await initialize();
    } else if (command === "restart") await restart();
    else if (command === "reload") await reload();
    else if (command === "screenshot") await screenshot(positional[0] ?? "state", options);
    else if (command === "check") await check();
    else if (command === "cli") {
      if (!positional.length)
        throw new Error("cli requires a Playwright command. Try cli snapshot.");
      if (
        positional.some((arg) =>
          /^(?:-s(?:=|$)|--(?:session|persistent|profile|config)(?:=|$))/.test(arg),
        ) ||
        [
          "open",
          "attach",
          "close",
          "detach",
          "delete-data",
          "close-all",
          "kill-all",
          "install",
          "install-browser",
        ].includes(positional[0])
      ) {
        throw new Error(
          "Use controller start/restart/reset/stop for session lifecycle; CLI cannot override its session or profile.",
        );
      }
      console.log(await cli(positional));
    }
    await health();
  }

  try {
    await commandMain();
  } catch (error) {
    if (structuredOutput) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(error.message);
    if (manifest?.runDir) await event("command-failed", { message: error.message });
    if (creating && manifest)
      await cleanup().catch((failure) => console.error(`Cleanup failed: ${failure.message}`));
    process.exitCode = 1;
  } finally {
    if (lockPath) await unlink(lockPath);
  }
}

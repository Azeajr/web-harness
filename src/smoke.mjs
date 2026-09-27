import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { directoryDigest } from "./core.mjs";
import { loadConfig } from "./config.mjs";
import { toJsonl } from "./evidence.mjs";
import { failures } from "./faults.mjs";
import { createStaticServer } from "./static-server.mjs";
import { watchContext } from "./watch.mjs";

// web-harness smoke [--dist DIR] [--output DIR]
//
// The production proof every deploy waits for. Against the built bytes, served the way the host
// serves them, in a fresh Chromium profile:
//   1. headers   every header the project requires is sent for /
//   2. bundle    the HTML is a production build (no Vite client, no /src/ module entry)
//   3. globals   no development accessor leaked into the bundle
//   4. sw        a service worker registers, and controls the page after one reload
//   5. persist   a visible action the project names survives a reload
//   6. offline   with the network cut, a reload renders the shell and the persisted data
//   7. faults    nothing above produced a page error, failed request, HTTP error or external call
//
// Proof boundary: Chromium only, a local static server, no Pages Functions, no real device. It
// establishes that THIS artifact installs and works offline, not that the edge or iOS does.
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dist: { type: "string" },
      output: { type: "string", default: ".web-harness/smoke" },
      headed: { type: "boolean", default: false },
    },
    strict: true,
  });
  const config = await loadConfig();
  const smoke = config.smoke ?? {};
  const dist = path.resolve(config.root, values.dist ?? smoke.dist ?? "dist");
  const output = path.resolve(config.root, values.output);
  await mkdir(output, { recursive: true });
  const require = createRequire(path.join(config.playwrightFrom, "package.json"));
  const { chromium } = require("playwright");

  const report = {
    project: config.name,
    dist,
    digest: await directoryDigest(dist),
    startedAt: new Date().toISOString(),
    checks: [],
    faults: [],
    warnings: [],
    ok: false,
  };
  const checks = report.checks;
  const pass = (name, detail = null) => checks.push({ name, ok: true, detail });
  const served = await createStaticServer({
    dir: dist,
    port: 0,
    identity: null,
    unservedPrefixes: config.policy.unservedPrefixes,
  });
  const origin = served.url;
  let browser;
  let page;
  let rings = null;
  try {
    const response = await fetch(`${origin}/`);
    const html = await response.text();
    if (!response.ok) throw new Error(`GET / answered ${response.status}.`);
    const missing = (smoke.requiredHeaders ?? []).filter(
      (name) => !response.headers.has(name.toLowerCase()),
    );
    if (missing.length) throw new Error(`Missing required headers on /: ${missing.join(", ")}.`);
    pass("headers", Object.fromEntries(response.headers));
    if (/\/@vite\/client|src="\/src\//.test(html))
      throw new Error("index.html references the Vite dev client or /src/ modules.");
    pass("bundle");

    browser = await chromium.launch({ headless: !values.headed });
    const context = await browser.newContext({ serviceWorkers: "allow" });
    const record = (kind, detail) => report.faults.push({ kind, detail, phase: report.phase });
    rings = await watchContext(context, {
      policy: config.policy,
      origin,
      record,
      warn: (detail) => report.warnings.push(detail),
      initScript: config.initScript,
      evidence: config.evidence,
    });
    page = await context.newPage();
    const ready = async () => {
      if (smoke.ready) await smoke.ready(page);
      else await page.waitForLoadState("load");
    };

    report.phase = "load";
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
    await ready();
    const devGlobals = ["__e2eResetDb", "__harness", ...(smoke.devGlobals ?? [])];
    const leaked = await page.evaluate(
      (names) => names.filter((name) => name in window),
      devGlobals,
    );
    if (leaked.length) throw new Error(`Development globals in production: ${leaked.join(", ")}.`);
    pass("globals", devGlobals);

    if (smoke.serviceWorker !== false) {
      report.phase = "sw";
      await page.evaluate(
        () =>
          Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("No service worker became ready in 30s.")), 30_000),
            ),
          ]).then(() => true),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
      if (!controlled) throw new Error("The service worker does not control the page after a reload.");
      pass("sw");
    }

    let token = null;
    if (smoke.persist) {
      report.phase = "persist";
      token = (await smoke.persist(page)) ?? null;
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      if (smoke.verify) await smoke.verify(page, token);
      pass("persist", token);
    }

    if (smoke.offline !== false && smoke.serviceWorker !== false) {
      report.phase = "offline";
      await context.setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      if (smoke.persist && smoke.verify) await smoke.verify(page, token);
      await context.setOffline(false);
      pass("offline");
    }

    report.phase = "faults";
    // Offline, the service worker trying the network first and falling back to cache is the
    // mechanism under test, not a fault. Kept as evidence; a PAGE request failing is not excused.
    const swFallback = /^sw [A-Z]+ \S+: net::ERR_INTERNET_DISCONNECTED$/;
    report.swFallbacks = report.faults.filter(
      (fault) => fault.phase === "offline" && fault.kind === "requestfailed" && swFallback.test(fault.detail),
    );
    const judged = report.faults.filter((fault) => !report.swFallbacks.includes(fault));
    const remaining = failures(judged, config.policy, smoke.allowedFaults ?? []);
    if (remaining.length) {
      // One broken thing usually faults in every phase; name each distinct fault once.
      const distinct = [...new Set(remaining.map((fault) => `${fault.kind}: ${fault.detail}`))];
      throw new Error(
        `${remaining.length} fault(s), ${distinct.length} distinct (all in report.json): ${distinct
          .slice(0, 3)
          .map((line) => line.slice(0, 300))
          .join(" | ")}`,
      );
    }
    pass("faults");
    report.ok = true;
  } catch (error) {
    report.error = error.message;
    checks.push({ name: report.phase ?? "http", ok: false, detail: error.message });
    if (page)
      await page
        .screenshot({ path: path.join(output, "failure.png"), fullPage: true })
        .then(() => (report.screenshot = path.join(output, "failure.png")))
        .catch(() => {});
    // Every request and console line of the run, for explaining the failure without a rerun.
    if (rings) {
      await writeFile(path.join(output, "network.jsonl"), toJsonl(rings.requests.entries));
      await writeFile(path.join(output, "console.jsonl"), toJsonl(rings.console.entries));
      report.evidence = { network: path.join(output, "network.jsonl"), console: path.join(output, "console.jsonl") };
    }
  } finally {
    await browser?.close().catch(() => {});
    await served.close();
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.ok ? "" : `: ${check.detail}`}`);
  console.log(`digest ${report.digest}\nreport ${path.join(output, "report.json")}`);
  if (!report.ok) process.exitCode = 1;
  return report;
}


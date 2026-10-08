import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { A11Y_BOUNDARY, axeLoaderSource, axeSource, classifyA11y, runAxe } from "./a11y.mjs";
import { directoryDigest } from "./core.mjs";
import { sourceIdentity } from "./provenance.mjs";
import { outcome } from "./status.mjs";
import { loadConfig } from "./config.mjs";
import { toJsonl } from "./evidence.mjs";
import { failures } from "./faults.mjs";
import { createStaticServer } from "./static-server.mjs";
import { watchContext } from "./watch.mjs";

export const usage = `Usage: web-harness smoke [--dist DIR] [--output DIR] [--headed]
Prove the production build in a fresh host Chromium profile, served the way Pages serves it:
headers, bundle, globals, a11y, sw, persist, offline, online, update, faults. Exits 1 on a failure.
  --dist DIR    Build to check (default smoke.dist in harness.config.mjs, else dist)
  --output DIR  Report directory (default .web-harness/smoke)
  --headed      Show the browser`;

// The production proof every deploy waits for. Against the built bytes, served the way the host
// serves them, in a fresh Chromium profile:
//   1. headers   every required header (and value) on every named path
//   2. bundle    the HTML is a production build (no Vite client, no /src/ module entry)
//   3. globals   no development accessor leaked into the bundle
//   4. a11y      with the adapter's `a11y` block (and axe-core installed): no axe violation at or
//                above its impact on the first screen
//   5. sw        a service worker registers, and controls the page after one reload
//   6. persist   a visible action the project names survives a reload
//   7. offline   with the network cut, a reload renders the shell and the persisted data
//   8. online    back online, a reload still renders it and nothing fails on reconnect
//   9. update    a new version is detected, waits for consent, activates when accepted, keeps the
//                user's data and does not reload in a loop
//  10. faults    nothing above produced a page error, failed request, HTTP error or external call
//
// Proof boundary: Chromium only, a local static server, no Pages Functions, no real device. It
// establishes that THIS artifact installs, works offline and updates, not that the edge or iOS
// does. The update phase's second version differs from the artifact only in the service-worker
// script's bytes: it proves the update lifecycle, not the fetching of changed assets.

// Normalized header rules: { path: [{ name, match }] }. The array form names headers on / only.
export function headerRules(required) {
  const entries = Array.isArray(required) || !required ? [["/", required ?? []]] : Object.entries(required);
  return entries.map(([pathname, rules]) => ({
    pathname,
    rules: rules.map((rule) => {
      const name = (typeof rule === "string" ? rule : rule.name)?.toLowerCase();
      if (!name) throw new Error(`smoke.requiredHeaders for ${pathname}: each rule is a name or { name, match }.`);
      const match = typeof rule === "string" || !rule.match ? null : new RegExp(rule.match);
      return { name, match };
    }),
  }));
}

// A pattern path (/assets/*) is checked on the first file the build has under it.
export async function resolveHeaderPath(dist, pathname) {
  if (!pathname.includes("*")) return pathname;
  const directory = pathname.slice(0, pathname.indexOf("*"));
  const entries = await readdir(path.join(dist, directory), { withFileTypes: true }).catch(() => []);
  const file = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort()[0];
  return file ? `${directory}${file}` : null;
}

export function headerProblems(pathname, headers, rules) {
  const problems = [];
  for (const rule of rules) {
    const value = headers.get(rule.name);
    if (value === null) problems.push(`${pathname}: missing ${rule.name}`);
    else if (rule.match && !rule.match.test(value))
      problems.push(`${pathname}: ${rule.name} "${value.slice(0, 200)}" does not match /${rule.match.source}/`);
  }
  return problems;
}

// Node-side poll: a waitForFunction with an async predicate is satisfied by the Promise itself.
async function poll(page, predicate, arg, { timeout, interval = 250 }) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await page.evaluate(predicate, arg).catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

const registrationState = async () => {
  const registration = await navigator.serviceWorker.getRegistration();
  return {
    waiting: Boolean(registration?.waiting),
    installing: Boolean(registration?.installing),
    controlled: Boolean(navigator.serviceWorker.controller),
    changed: Boolean(window.__webHarnessControllerChanged),
  };
};

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
    source: await sourceIdentity(config.root),
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
  let versionB = null;
  try {
    report.phase = "headers";
    const response = await fetch(`${origin}/`);
    const html = await response.text();
    if (!response.ok) throw new Error(`GET / answered ${response.status}.`);
    const problems = [];
    const checked = {};
    for (const { pathname, rules } of headerRules(smoke.requiredHeaders)) {
      const resolved = await resolveHeaderPath(dist, pathname);
      if (!resolved) {
        problems.push(`${pathname}: no file in the build matches`);
        continue;
      }
      const answer = resolved === "/" ? response : await fetch(`${origin}${resolved}`);
      if (resolved !== "/") await answer.arrayBuffer();
      problems.push(...headerProblems(resolved, answer.headers, rules));
      checked[resolved] = Object.fromEntries(rules.map((rule) => [rule.name, answer.headers.get(rule.name)]));
    }
    if (problems.length) throw new Error(`Required headers: ${problems.join("; ")}.`);
    pass("headers", checked);
    report.phase = "bundle";
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

    if (config.a11y && smoke.a11y !== false) {
      report.phase = "a11y";
      const loadAxe = new Function(`return (${axeLoaderSource(await axeSource(config.root))})`)();
      const scan = classifyA11y(await runAxe(page, config.a11y, loadAxe), config.a11y);
      report.a11y = { impact: config.a11y.impact, records: [...scan.faults, ...scan.warnings], boundary: A11Y_BOUNDARY };
      report.warnings.push(...scan.warnings.map((warning) => warning.detail));
      const counted = scan.faults.filter((fault) => !fault.excusedBy);
      if (counted.length) throw new Error(`Accessibility: ${counted.map((fault) => fault.detail).join("; ")}.`);
      pass("a11y", { excused: scan.faults.length, warnings: scan.warnings.length });
    }

    const serviceWorker = smoke.serviceWorker !== false;
    if (serviceWorker) {
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
    const verify = async () => {
      if (smoke.persist && smoke.verify) await smoke.verify(page, token);
    };
    if (smoke.persist) {
      report.phase = "persist";
      token = (await smoke.persist(page)) ?? null;
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      if (smoke.verify) await smoke.verify(page, token);
      pass("persist", token);
    }

    if (smoke.offline !== false && serviceWorker) {
      report.phase = "offline";
      await context.setOffline(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      await verify();
      await context.setOffline(false);
      pass("offline");

      // Back online: the same page, reloaded, must still work, and reconnecting must not fail.
      report.phase = "online";
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready();
      await verify();
      if (smoke.reconnect) await smoke.reconnect(page);
      pass("online");
    }

    const update = smoke.update === false ? null : { sw: "sw.js", mode: "prompt", ...smoke.update };
    if (update && serviceWorker) {
      report.phase = "update";
      if (!["prompt", "auto"].includes(update.mode)) throw new Error('smoke.update.mode is "prompt" or "auto".');
      const detail = { mode: update.mode };
      // Version B: the artifact with only the service-worker script's bytes changed, or a real
      // second build when the project provides one.
      versionB = await mkdtemp(path.join(tmpdir(), "wh-smoke-update-"));
      if (update.build) await update.build(versionB);
      else {
        await cp(dist, versionB, { recursive: true });
        const script = path.join(versionB, update.sw);
        await readFile(script).catch(() => {
          throw new Error(`No ${update.sw} in the build; set smoke.update.sw, or smoke.update: false.`);
        });
        await appendFile(script, `\n// web-harness update probe ${Date.now()}\n`);
      }
      await page.evaluate(() => {
        window.__webHarnessControllerChanged = false;
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          window.__webHarnessControllerChanged = true;
        });
      });
      await served.swap(versionB);
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      if (update.mode === "prompt") {
        const found = await poll(page, async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          if (window.__webHarnessControllerChanged) return "changed";
          return registration?.waiting ? "waiting" : null;
        }, null, { timeout: 30_000 });
        if (found === "changed") throw new Error("The new version activated without consent (prompt mode).");
        if (!found) throw new Error("No waiting service worker 30s after the new version was published.");
        detail.detected = true;
        // A keeps working while B waits, and B does not take over on its own.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const waiting = await page.evaluate(registrationState);
        if (waiting.changed || !waiting.waiting)
          throw new Error("The new version activated without consent (prompt mode).");
        await verify();
        detail.consent = true;
        if (!update.prompt || !update.accept) {
          detail.activation = "not exercised: set smoke.update.prompt and smoke.update.accept";
          report.warnings.push(`update: ${detail.activation}`);
          pass("update", detail);
        } else {
          await update.prompt(page);
          if (update.dismiss) {
            await update.dismiss(page);
            await page.reload({ waitUntil: "domcontentloaded" });
            await ready();
            await update.prompt(page);
            detail.dismissed = "prompt returned after a reload";
          }
          let navigations = 0;
          const count = (frame) => {
            if (frame === page.mainFrame()) navigations++;
          };
          page.on("framenavigated", count);
          await update.accept(page);
          const activated = await poll(page, async () => {
            const registration = await navigator.serviceWorker.getRegistration();
            return Boolean(navigator.serviceWorker.controller && registration?.active && !registration.waiting);
          }, null, { timeout: 30_000 });
          if (!activated) throw new Error("Accepting the update did not activate the new version within 30s.");
          await page.waitForLoadState("domcontentloaded");
          await ready();
          const settledAt = navigations;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          page.off("framenavigated", count);
          if (navigations - settledAt > 1) throw new Error(`Reload loop: ${navigations} navigations after accepting the update.`);
          const probed = await page.evaluate(
            async (script) => (await (await fetch(`/${script}`, { cache: "no-store" })).text()).includes("web-harness update probe"),
            update.sw,
          );
          if (!update.build && !probed) throw new Error("The page is not being served the new version after activation.");
          await verify();
          detail.activated = true;
          detail.navigations = navigations;
          pass("update", detail);
        }
      } else {
        const changed = await poll(page, () => window.__webHarnessControllerChanged, null, { timeout: 30_000 });
        if (!changed) throw new Error("The new version did not take over within 30s (auto mode).");
        await page.waitForLoadState("domcontentloaded");
        await ready();
        await verify();
        detail.activated = true;
        pass("update", detail);
      }
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
    if (versionB) await rm(versionB, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    report.status = outcome({ ok: report.ok });
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  for (const check of checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.ok ? "" : `: ${check.detail}`}`);
  console.log(`digest ${report.digest}\nreport ${path.join(output, "report.json")}`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

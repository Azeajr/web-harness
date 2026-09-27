import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { faultPolicy, failures } from "../src/faults.mjs";
import { createStaticServer } from "../src/static-server.mjs";
import { watchContext } from "../src/watch.mjs";

// The watcher behind the Playwright fixture and the smoke, against a real Chromium. Every fault
// kind it claims to catch is induced once; the unserved prefix and plain warnings must not fault.
test("watchContext records every fault kind against a real browser", { timeout: 60_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    t.skip(`No Chromium for this Playwright (${error.message.split("\n")[0]})`);
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-watch-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>t</title><p>ok</p>");
  const served = await createStaticServer({ dir: directory, port: 0, unservedPrefixes: ["/api/"] });
  try {
    const context = await browser.newContext();
    const records = [];
    const warnings = [];
    const policy = faultPolicy({ unservedPrefixes: ["/api/"], watchedWarnings: ["^\\[engine\\]"] });
    await watchContext(context, {
      policy,
      origin: served.url,
      record: (kind, detail) => records.push({ kind, detail }),
      warn: (detail) => warnings.push(detail),
      initScript: () => {
        window.__initScriptRan = true;
      },
    });
    await context.route("**/boom", (route) => route.fulfill({ status: 500, body: "no" }));
    await context.route("**/abort", (route) => route.abort("failed"));
    const page = await context.newPage();
    await page.goto(`${served.url}/`);
    assert.equal(await page.evaluate(() => window.__initScriptRan), true);
    const external = await page.evaluate(async () => {
      console.error("induced console error");
      console.warn("[engine] induced watched warning");
      console.warn("ordinary warning");
      await fetch("/boom");
      await fetch("/abort").catch(() => null);
      await fetch("/api/changes");
      setTimeout(() => {
        throw new Error("induced page error");
      });
      return (await fetch("https://external.invalid/x")).json();
    });
    await page.waitForTimeout(200);
    assert.equal(external, null, "external calls are stubbed with JSON null");
    const kinds = new Set(records.map((record) => record.kind));
    for (const kind of ["console.error", "console.warning", "http", "requestfailed", "external", "pageerror"])
      assert.ok(kinds.has(kind), `missing ${kind}: ${JSON.stringify(records)}`);
    assert.ok(!records.some((record) => record.detail.includes("/api/changes")), "unserved prefix faulted");
    assert.ok(warnings.some((warning) => warning.includes("ordinary warning")));
    assert.ok(
      !records.some((record) => record.detail.includes("ordinary warning")),
      "an ordinary warning is evidence, not a fault",
    );
    assert.ok(failures(records, policy).length >= 6);
  } finally {
    await browser.close();
    await served.close();
    await rm(directory, { recursive: true, force: true });
  }
});

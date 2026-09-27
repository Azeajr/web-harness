import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
  DEFAULT_REDACT_QUERY,
  captureStorage,
  installEvidence,
  mergeTimeline,
  pushRing,
  redactUrl,
  sliceRing,
  summarizeFailure,
  toJsonl,
} from "../src/evidence.mjs";
import { createStaticServer } from "../src/static-server.mjs";

test("redaction replaces sensitive query values and keeps the rest of the URL", () => {
  assert.equal(
    redactUrl("https://x.test/a?token=abc&page=2&pairCode=77#top", DEFAULT_REDACT_QUERY),
    "https://x.test/a?token=[redacted]&page=2&pairCode=[redacted]#top",
  );
  assert.equal(redactUrl("/plain/path", DEFAULT_REDACT_QUERY), "/plain/path");
  assert.equal(redactUrl("/a?flag&session=1", DEFAULT_REDACT_QUERY), "/a?flag&session=[redacted]");
  // Serialized, it must not depend on module scope.
  const serialized = new Function(`return (${redactUrl.toString()})`)();
  assert.equal(serialized("/a?key=1", ["key"]), "/a?key=[redacted]");
});

test("rings are bounded, count what they drop, and slice from a mark with context", () => {
  const ring = { entries: [], dropped: 0 };
  for (let seq = 1; seq <= 12; seq++) pushRing(ring, { seq }, 10);
  assert.equal(ring.entries.length, 10);
  assert.equal(ring.dropped, 2);
  assert.equal(ring.entries[0].seq, 3);
  const slice = sliceRing(ring, 9, 2);
  assert.deepEqual(slice.entries.map((entry) => entry.seq), [8, 9, 10, 11, 12]);
  assert.equal(slice.dropped, 2);
  assert.deepEqual(sliceRing(ring, 99, 2).entries.map((entry) => entry.seq), [11, 12]);
});

test("the timeline interleaves every source by time and tags each row", () => {
  const rows = mergeTimeline(
    {
      events: [{ at: "2026-01-01T00:00:00.000Z", kind: "command" }],
      steps: [{ name: "save", ok: false, ms: 5, startedAt: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:04.000Z" }],
      faults: [{ at: "2026-01-01T00:00:03.000Z", kind: "http", detail: "500 /x" }],
      console: [{ at: "2026-01-01T00:00:02.500Z", type: "error", text: "boom" }],
      requests: [{ at: "2026-01-01T00:00:02.000Z", method: "GET", url: "/x", status: 500 }],
    },
    { runId: "r", batchId: "b" },
  );
  assert.deepEqual(rows.map((row) => row.source), ["controller", "step", "request", "console", "fault", "step"]);
  assert.ok(rows.every((row) => row.runId === "r" && row.batchId === "b"));
  assert.equal(rows.at(-1).event, "failed");
  assert.equal(toJsonl(rows).trim().split("\n").length, 6);
  assert.equal(toJsonl([]), "");
});

test("the failure summary names the first counted fault, bad requests and a waiting worker", () => {
  const summary = summarizeFailure({
    faults: [
      { kind: "console.error", detail: "excused", excusedBy: "b1" },
      { kind: "http", detail: "500 http://x/api" },
    ],
    requests: [
      { method: "GET", url: "/ok", status: 200 },
      { method: "GET", url: "/bad", status: 500 },
      { method: "GET", url: "/gone", status: null, failure: "net::ERR_FAILED" },
    ],
    console: [{ type: "error", text: "first" }, { type: "log", text: "x" }, { type: "error", text: "last" }],
    storage: { url: "http://x/", serviceWorker: { registration: { waiting: { scriptURL: "http://x/sw.js" } } } },
  });
  assert.deepEqual(summary, {
    firstFault: "http: 500 http://x/api",
    failedRequests: ["GET /bad → 500", "GET /gone → net::ERR_FAILED"],
    lastConsoleError: "last",
    url: "http://x/",
    waitingServiceWorker: "http://x/sw.js",
  });
});

test("installEvidence records requests and console lines against a real browser", { timeout: 60_000 }, async (t) => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    t.skip(`No Chromium for this Playwright (${error.message.split("\n")[0]})`);
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-evidence-"));
  await writeFile(path.join(directory, "index.html"), "<!doctype html><title>t</title><p>ok</p>");
  await writeFile(path.join(directory, "404.html"), "<!doctype html><p>missing</p>");
  const served = await createStaticServer({ dir: directory, port: 0 });
  try {
    const context = await browser.newContext();
    const evidence = installEvidence(
      context,
      { redactQuery: DEFAULT_REDACT_QUERY, requestCap: 100, consoleCap: 100 },
      { redactUrl, pushRing },
    );
    assert.equal(installEvidence(context, {}, {}), evidence, "idempotent");
    const page = await context.newPage();
    await page.goto(`${served.url}/`);
    await page.evaluate(async () => {
      console.log("hello");
      console.error("broken");
      await fetch("/missing.json?token=abc");
    });
    await page.waitForTimeout(100);
    const missing = evidence.requests.entries.find((entry) => entry.url.includes("missing.json"));
    assert.equal(missing.status, 404);
    assert.match(missing.url, /token=\[redacted\]/);
    assert.equal(typeof missing.ms, "number");
    // Every console line, the browser's own "Failed to load resource" for the 404 included.
    const lines = evidence.console.entries.map((line) => [line.type, line.text]);
    assert.deepEqual(lines.slice(0, 2), [["log", "hello"], ["error", "broken"]]);
    assert.ok(lines.some(([type, text]) => type === "error" && /Failed to load resource.*404/.test(text)), JSON.stringify(lines));
    const storage = await captureStorage(page);
    assert.equal(storage.url, `${served.url}/`);
    assert.ok(Array.isArray(storage.localStorageKeys));
    assert.equal(storage.serviceWorker.registration, null);
  } finally {
    await browser.close();
    await served.close();
    await rm(directory, { recursive: true, force: true });
  }
});

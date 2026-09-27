import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  consoleKind,
  describeConsole,
  failures,
  faultPolicy,
  isExternal,
  isUnserved,
  isUnservedLoad,
  unmetExpectations,
} from "../src/faults.mjs";

test("fault policy retains every failure kind and only excuses ResizeObserver page/console noise", () => {
  const policy = faultPolicy();
  const records = [
    "console.error",
    "console.warning",
    "pageerror",
    "crash",
    "http",
    "requestfailed",
    "external",
  ].map((kind) => ({ kind, detail: "test failure" }));
  assert.deepEqual(failures(records, policy), records);
  const noise = "ResizeObserver loop completed with undelivered notifications";
  assert.deepEqual(failures([{ kind: "pageerror", detail: noise }], policy), []);
  assert.equal(failures([{ kind: "external", detail: noise }], policy).length, 1);
  assert.throws(() => failures(undefined, policy), /missing/);
});

test("project allowances excuse only page output; test-local allowances may name any kind", () => {
  const policy = faultPolicy({ allowed: [/vendor noise/] });
  assert.deepEqual(failures([{ kind: "console.error", detail: "vendor noise" }], policy), []);
  assert.equal(failures([{ kind: "requestfailed", detail: "vendor noise" }], policy).length, 1);
  assert.deepEqual(
    failures([{ kind: "requestfailed", detail: "GET /openings.tsv: net::ERR_FAILED" }], policy, [
      /openings\.tsv/,
    ]),
    [],
  );
});

test("policy rejects flags, malformed patterns and unknown external modes", () => {
  assert.throws(() => faultPolicy({ allowed: [/x/i] }), /flags/);
  assert.throws(() => faultPolicy({ allowed: ["("] }));
  assert.throws(() => faultPolicy({ external: "ignore" }), /external/);
  assert.equal(faultPolicy({ watchedWarnings: [/^\[engine\]/] }).watchedWarnings[0], "^\\[engine\\]");
});

test("console classification: errors fault, watched warnings fault, other warnings are evidence", () => {
  const policy = faultPolicy({ watchedWarnings: ["^\\[engine\\]"] });
  assert.equal(consoleKind("error", "boom", policy), "console.error");
  assert.equal(consoleKind("warning", "[engine] dead", policy), "console.warning");
  assert.equal(consoleKind("warning", "deprecated", policy), "warning");
  assert.equal(consoleKind("log", "hello", policy), null);
  assert.equal(
    describeConsole("boom", { url: "http://127.0.0.1/app.js", lineNumber: 3 }),
    "boom (http://127.0.0.1/app.js:3)",
  );
});

test("external and unserved requests are judged against the app origin", () => {
  const origin = "http://127.0.0.1:5175";
  const policy = faultPolicy({ unservedPrefixes: ["/api/"] });
  assert.equal(isExternal("https://lichess.org/api", origin), true);
  assert.equal(isExternal("http://127.0.0.1:9999/other", origin), true);
  assert.equal(isExternal(`${origin}/assets/a.js`, origin), false);
  assert.equal(isExternal("data:text/plain,x", origin), false);
  assert.equal(isUnserved(`${origin}/api/changes`, origin, policy), true);
  assert.equal(isUnserved(`${origin}/apiary`, origin, policy), false);
  assert.equal(isUnserved("https://other.example/api/x", origin, policy), false);
  assert.equal(isUnserved(`${origin}`, origin, policy), false);
  assert.equal(isUnserved(`${origin}/api/`, origin, policy), true);
  assert.equal(isExternal("HTTP://127.0.0.1:5175/a", origin), false);
});

test("expected faults are counted: one that never fired is reported", () => {
  const records = [{ kind: "requestfailed", detail: "GET /x: net::ERR_FAILED" }];
  assert.deepEqual(unmetExpectations(records, [{ kind: "requestfailed", pattern: "/x" }]), []);
  assert.equal(unmetExpectations(records, [{ kind: "http", pattern: "/x" }]).length, 1);
  assert.equal(unmetExpectations(records, [{ pattern: "/y" }]).length, 1);
});

test("classifiers survive serialization into the browser tooling unchanged", () => {
  // The controller ships these with toString(); a closure over module scope would break there.
  // An empty context, like run-code's sandbox: no URL, no module scope.
  const lib = runInNewContext(
    `({ consoleKind: ${consoleKind}, describeConsole: ${describeConsole}, isExternal: ${isExternal}, isUnserved: ${isUnserved}, isUnservedLoad: ${isUnservedLoad}, failures: ${failures} })`,
  );
  assert.equal(lib.isExternal("https://lichess.org/x", "http://127.0.0.1:1"), true);
  assert.equal(lib.isExternal("http://127.0.0.1:1/x?y", "http://127.0.0.1:1"), false);
  const policy = faultPolicy({ watchedWarnings: ["^\\[engine\\]"], unservedPrefixes: ["/api/"] });
  const load = (url) =>
    lib.isUnservedLoad("Failed to load resource: 404", { url }, "http://a", policy);
  assert.equal(load("http://a/api/x"), true);
  assert.equal(load("http://a/app.js"), false);
  assert.equal(lib.isUnservedLoad("boom", { url: "http://a/api/x" }, "http://a", policy), false);
  for (const [type, text] of [
    ["error", "x"],
    ["warning", "[engine] y"],
    ["warning", "z"],
    ["info", "w"],
  ])
    assert.equal(lib.consoleKind(type, text, policy), consoleKind(type, text, policy));
  assert.equal(lib.isUnserved("http://a/api/x", "http://a", policy), true);
  assert.equal(
    lib.failures([{ kind: "pageerror", detail: "ResizeObserver loop limit exceeded" }], policy).length,
    0,
  );
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { devices } from "playwright";
import { batchSource } from "../src/batch.mjs";
import { observe, readState } from "../src/inspect.mjs";
import { faultPolicy } from "../src/faults.mjs";
import {
  acquirePortLease,
  availablePort,
  deviceFor,
  directoryDigest,
  imageFor,
  ownsContainer,
  ownsProcess,
  parseArgs,
  processIdentity,
  releasePortLease,
  resolvePath,
  resultJson,
  reviewUrl,
  serverIdentity,
  slug,
  targetUrl,
} from "../src/core.mjs";

const policy = faultPolicy();

test("CLI transport preserves literal code and uses controller options before cli", () => {
  const code = "async page => page.getByRole('button', { name: '$HOME `literal`' }).click()";
  assert.deepEqual(parseArgs(["--", "--session", "test", "cli", "run-code", code]), {
    command: "cli",
    options: { session: "test" },
    positional: ["run-code", code],
  });
  assert.equal(parseArgs(["start", "--device=iPhone 13 Mini"]).options.device, "iPhone 13 Mini");
  for (const args of [["start", "--bad"], ["start", "--device"], ["start", "extra"], ["oops"]])
    assert.throws(() => parseArgs(args));
  for (const value of ["../other", "", "-bad", "A", "a/b", "x".repeat(49)])
    assert.throws(() => slug(value));
});

test("adapter options extend parsing but cannot shadow controller options", () => {
  assert.equal(parseArgs(["start", "--pgn", "a.pgn"], { extraValueOptions: ["pgn"] }).options.pgn, "a.pgn");
  assert.throws(() => parseArgs(["start", "--pgn", "a.pgn"]), /Unknown option/);
  assert.throws(() => parseArgs(["start"], { extraValueOptions: ["port"] }), /shadows/);
  assert.throws(() => parseArgs(["start"], { extraValueOptions: ["help"] }), /shadows/);
});

test("targets are dev or production, and production is never an attached server", () => {
  assert.equal(parseArgs(["start", "--target", "production"]).options.target, "production");
  assert.throws(() => parseArgs(["start", "--target", "staging"]), /dev or production/);
  assert.throws(
    () => parseArgs(["start", "--target", "production", "--url", "http://127.0.0.1:4000"]),
    /always owned/,
  );
});

test("structured commands require explicit targets and preserve selectors and filenames", () => {
  assert.equal(
    parseArgs(["observe", 'button[aria-label="Open document"]']).positional[0],
    'button[aria-label="Open document"]',
  );
  assert.equal(parseArgs(["run", "a file.js"]).positional[0], "a file.js");
  assert.equal(parseArgs(["state"]).command, "state");
  for (const args of [["observe"], ["run"], ["state", "extra"], ["run", "a", "b"]])
    assert.throws(() => parseArgs(args));
  assert.equal(parseArgs(["run", "--help"]).options.help, true);
  for (const command of ["reload", "restart", "doctor"]) assert.equal(parseArgs([command]).command, command);
});

const spec = "{ sections: ['document'], defaults: ['document'], target: 'dev', read: null }";

test("batch stops at failed assertion and retains step, screenshot and state evidence", async () => {
  const screenshots = [];
  const page = {
    context: () => ({ __webHarnessFaults: [] }),
    screenshot: async (options) => screenshots.push(options.path),
    url: () => "http://127.0.0.1:1/",
    evaluate: async () => ({ documentId: "one", revision: 2 }),
  };
  const execute = runInNewContext(
    batchSource(
      `async (page, {step, assert}) => {
    await step('first', async () => true);
    await step('broken', async () => assert(false, 'expected failure'));
    await step('must not run', async () => true);
  };`,
      "/tmp/evidence",
      {
        policy,
        stateSpec:
          "{ sections: ['document'], defaults: ['document'], target: 'dev', read: () => null }",
      },
    ),
  );
  const result = await execute(page);
  assert.equal(result.ok, false);
  assert.equal(result.error, "expected failure");
  assert.deepEqual(
    Array.from(result.steps, (item) => [item.name, item.ok]),
    [
      ["first", true],
      ["broken", false],
    ],
  );
  assert.deepEqual(screenshots, ["/tmp/evidence.png"]);
  assert.equal(result.artifacts.state.revision, 2);
});

test("batch captures retained faults and serialization errors without masking original failures", async () => {
  const page = {
    context: () => ({ __webHarnessFaults: [{ kind: "pageerror", detail: "earlier fault" }] }),
    url: () => "http://127.0.0.1:1/",
    screenshot: async () => {
      throw new Error("page closed");
    },
    evaluate: async () => {
      throw new Error("state unavailable");
    },
  };
  const read = "{ sections: [], defaults: [], target: 'dev', read: () => null }";
  const execute = runInNewContext(
    batchSource("async () => ({ done: true })", "/tmp/evidence", { policy, stateSpec: read }),
  );
  const failed = await execute(page);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /earlier fault/);
  assert.equal(failed.artifactErrors.length, 2);
  page.context = () => ({ __webHarnessFaults: [] });
  const success = await execute(page);
  assert.equal(success.ok, true);
  assert.equal(success.artifactErrors.length, 0);
  const circular = runInNewContext(
    batchSource(
      "async () => { const value = {}; value.self = value; return value; }",
      "/tmp/evidence",
      { policy, stateSpec: read },
    ),
  );
  assert.equal((await circular(page)).ok, false);
  assert.throws(() => batchSource("async page => {", "/tmp/evidence", { policy }));
});

test("batch honours the project's fault policy, not a hardcoded one", async () => {
  const page = {
    context: () => ({ __webHarnessFaults: [{ kind: "console.error", detail: "known vendor noise" }] }),
    url: () => "http://127.0.0.1:1/",
    screenshot: async () => {},
    evaluate: async () => null,
  };
  const run = (faults) =>
    runInNewContext(
      batchSource("async () => true", "/tmp/evidence", { policy: faultPolicy(faults), stateSpec: spec }),
    )(page);
  assert.equal((await run({})).ok, false);
  assert.equal((await run({ allowed: ["known vendor noise"] })).ok, true);
});

test("inspection rejects unbounded queries and unknown state sections before browser access", async () => {
  for (const options of [
    { limit: 0 },
    { limit: 21 },
    { textLimit: 2001 },
    { css: [1] },
    { attributes: Array(21).fill("id") },
  ])
    await assert.rejects(observe({}, "button", options));
  await assert.rejects(
    readState({}, ["apiKey"], { sections: ["document"], defaults: [], read: () => null }),
    /state sections: document/,
  );
});

test("production targets report state as unsupported instead of fabricating it", async () => {
  const page = { url: () => "http://127.0.0.1:1/", evaluate: async () => assert.fail("no accessor") };
  const result = await readState(page, undefined, {
    sections: ["document"],
    defaults: ["document"],
    target: "production",
    read: () => ({}),
  });
  assert.match(result.unsupported, /Production builds carry no development accessors/);
});

test("review ports and lifetime leases isolate owners even while their server is down", async () => {
  assert.equal(
    reviewUrl({ port: "4182", route: "/?review=1" }, 4173),
    "http://127.0.0.1:4182/?review=1",
  );
  assert.equal(reviewUrl({}, 5175), "http://127.0.0.1:5175/");
  for (const port of ["0", "80", "65536", "1.2", "abc"])
    assert.throws(() => reviewUrl({ port }, 4173));
  assert.throws(() => reviewUrl({ url: "http://localhost:4182", port: "4182" }, 4173));
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  const lease = await acquirePortLease(url, { token: "test-owner", root: "/one" });
  try {
    await assert.rejects(acquirePortLease(url, { token: "other", root: "/two" }), /reserved/);
    await assert.rejects(releasePortLease(lease, "other"), /mismatch/);
  } finally {
    await releasePortLease(lease, "test-owner");
  }
});

test("server identity rejects another worktree or a restarted server on the same URL", async () => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/__web-harness/identity") return response.writeHead(404).end();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ root: "/one", token: "server-a" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await serverIdentity(url, "/one", "server-a")).token, "server-a");
    await assert.rejects(serverIdentity(url, "/two", "server-a"), /identity/);
    await assert.rejects(serverIdentity(url, "/one", "server-b"), /identity/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("device validation rejects implicit fallbacks and absent descriptors", () => {
  assert.equal(deviceFor(devices, "iPhone 13 Mini", "webkit").viewport.width, 375);
  assert.throws(() => deviceFor(devices, "iPhone 13 Mini", "chromium"), /requires webkit/);
  assert.throws(() => deviceFor(devices, "missing", "webkit"), /Unknown/);
  assert.equal(imageFor("1.63.0"), "mcr.microsoft.com/playwright:v1.63.0-noble");
});

test("paths reject traversal, root mounts, and symlink escapes before file access", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-path-test-"));
  try {
    const root = path.join(directory, "repo");
    await mkdir(root);
    await symlink(directory, path.join(root, "escape"));
    assert.equal(await resolvePath(root, "output/new"), path.join(root, "output/new"));
    await assert.rejects(resolvePath(root, "../outside"));
    await assert.rejects(resolvePath(root, "escape/new"));
    await assert.rejects(resolvePath(root, ".", { outside: true }));
    await assert.rejects(resolvePath(root, "/", { outside: true }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("URL validation cannot escape local origin or include credentials", () => {
  assert.equal(targetUrl("http://127.0.0.1:4173", "/?review=1"), "http://127.0.0.1:4173/?review=1");
  for (const url of ["https://example.com", "http://user:password@localhost", "file:///tmp/x"])
    assert.throws(() => targetUrl(url));
  for (const route of ["//example.com", "/\\example.com", "https://example.com"])
    assert.throws(() => targetUrl("http://127.0.0.1:4173", route));
});

test("occupied ports fail without attaching to or stopping their listener", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(availablePort(`http://127.0.0.1:${server.address().port}`), /occupied/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ownership rejects recycled PIDs, foreign commands, and foreign containers", async () => {
  const actual = await processIdentity(process.pid);
  const entry = actual.cmdline.split("\0").find((item) => item.endsWith(".mjs")) ?? actual.cmdline.split("\0")[0];
  assert.equal(ownsProcess(actual, actual, actual.cwd, entry), true);
  assert.equal(ownsProcess({ ...actual, startTicks: "0" }, actual, actual.cwd, entry), false);
  assert.equal(ownsProcess(actual, actual, actual.cwd, "/foreign/server.mjs"), false);
  assert.equal(ownsProcess(actual, null, actual.cwd, entry), false);
  const manifest = { containerId: "abc", imageId: "sha256:test", root: "/repo", token: "unique" };
  const info = {
    Id: "abc",
    Image: "sha256:test",
    Config: { Labels: { "web-harness.root": "/repo", "web-harness.token": "unique" } },
  };
  assert.equal(ownsContainer(manifest, info), true);
  assert.equal(ownsContainer({ ...manifest, token: "foreign" }, info), false);
  assert.equal(ownsContainer({ ...manifest, imageId: "changed" }, info), false);
  assert.throws(() => resultJson("### Error\nFailed"), /invalid structured/);
  assert.deepEqual(resultJson('{"ok":true}'), { ok: true });
});

test("build digests track bytes and paths, not timestamps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-digest-"));
  try {
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "index.html"), "<p>one</p>");
    await writeFile(path.join(directory, "assets/app.js"), "1");
    const first = await directoryDigest(directory);
    await writeFile(path.join(directory, "assets/app.js"), "1");
    assert.equal(await directoryDigest(directory), first);
    await writeFile(path.join(directory, "assets/app.js"), "2");
    assert.notEqual(await directoryDigest(directory), first);
    await rm(path.join(directory, "assets/app.js"));
    await writeFile(path.join(directory, "assets/app2.js"), "2");
    assert.notEqual(await directoryDigest(directory), first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { environmentConfig } from "../src/config.mjs";
import { SECRET, serverEnvironment } from "../src/hostenv.mjs";
import { artifactKind, validateManifest } from "../src/manifest.mjs";
import { sourceIdentity } from "../src/provenance.mjs";
import { STATUS, outcome } from "../src/status.mjs";

test("the dirty digest names uncommitted work: edits and new files change it, nothing else does", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wh-source-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@invalid", ...args], { cwd: root });
  try {
    git("init", "-q");
    await writeFile(path.join(root, "a.txt"), "one\n");
    git("add", "-A");
    git("commit", "-qm", "one");
    const clean = await sourceIdentity(root);
    assert.match(clean.commit, /^[0-9a-f]{40}$/);
    assert.equal(clean.dirty, false);
    assert.equal(clean.dirtyDigest, null);
    await writeFile(path.join(root, "a.txt"), "two\n");
    const edited = await sourceIdentity(root);
    assert.equal(edited.dirty, true);
    assert.match(edited.dirtyDigest, /^[0-9a-f]{64}$/);
    assert.equal((await sourceIdentity(root)).dirtyDigest, edited.dirtyDigest, "stable while nothing changes");
    await writeFile(path.join(root, "b.txt"), "new\n");
    const added = await sourceIdentity(root);
    assert.notEqual(added.dirtyDigest, edited.dirtyDigest);
    assert.equal(added.untracked, 1);
    await writeFile(path.join(root, "b.txt"), "newer\n");
    assert.notEqual((await sourceIdentity(root)).dirtyDigest, added.dirtyDigest, "untracked content counts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(await sourceIdentity(os.tmpdir()), { commit: null, branch: null, dirty: null, dirtyDigest: null, untracked: null });
});

test("the server environment keeps tools, drops credentials, and moves HOME into the session", () => {
  const env = {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config__authToken: "secret",
    GH_TOKEN: "ghp_x",
    CLOUDFLARE_API_TOKEN: "cf",
    AWS_SECRET_ACCESS_KEY: "aws",
    VITE_API: "http://x",
    VITE_SENTRY_AUTH_TOKEN: "s",
    HOME: "/home/me",
    RANDOM_THING: "1",
  };
  const { env: result, passed, dropped, isolated } = serverEnvironment(env, {
    home: "/s/home",
    allow: ["VITE_*", "RANDOM_THING"],
    realHome: "/home/me",
  });
  assert.equal(isolated, true);
  assert.equal(result.HOME, "/s/home");
  assert.equal(result.XDG_CACHE_HOME, "/s/home/.cache");
  assert.equal(result.COREPACK_HOME, "/home/me/.cache/node/corepack");
  for (const name of ["PATH", "LANG", "LC_ALL", "npm_config_registry", "VITE_API", "RANDOM_THING"])
    assert.ok(passed.includes(name), `${name} passes`);
  for (const name of ["GH_TOKEN", "CLOUDFLARE_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "npm_config__authToken", "VITE_SENTRY_AUTH_TOKEN"])
    assert.ok(!(name in result) && dropped.includes(name), `${name} is dropped`);
  // Named exactly, a secret-looking variable passes: the adapter said so.
  assert.equal(serverEnvironment(env, { home: "/s", allow: ["GH_TOKEN"] }).env.GH_TOKEN, "ghp_x");
  assert.equal(serverEnvironment(env, { home: "/s", isolate: false }).env.HOME, "/home/me");
  assert.ok(SECRET.test("MY_PRIVATE_KEY"));
});

test("environment: requested timezone, locale and clock, overridable per session", () => {
  assert.deepEqual(environmentConfig(), { timezoneId: null, locale: null, clock: "real", now: null });
  assert.deepEqual(
    environmentConfig({ timezoneId: "UTC", locale: "en-US" }, { timezoneId: "Pacific/Kiritimati", clock: "install", now: "2026-11-01T05:59:00Z" }),
    { timezoneId: "Pacific/Kiritimati", locale: "en-US", clock: "install", now: "2026-11-01T05:59:00.000Z" },
  );
  assert.throws(() => environmentConfig({ clock: "fixed" }), /needs environment.now/);
  assert.throws(() => environmentConfig({ timezoneId: "Nowhere/Land" }), /Unknown timezone/);
});

test("one status vocabulary, decided by the source of a failure", () => {
  assert.equal(outcome({ ok: true }), STATUS.passed);
  assert.equal(outcome({ ok: false }), STATUS.failed);
  assert.equal(outcome({ ok: false, infrastructure: true }), STATUS.infrastructureFailed);
  assert.deepEqual(Object.values(STATUS), ["passed", "failed", "infrastructure_failed", "not_run", "unsupported", "flaky"]);
});

test("the manifest validator accepts a v3 manifest and names what a broken one lacks", () => {
  const valid = {
    schemaVersion: 3,
    project: "example",
    root: "/r",
    session: "s",
    output: "/r/.web-harness",
    runId: "run",
    runDir: "/r/.web-harness/s/run",
    profileDir: "/r/.web-harness/s/profile",
    image: "mcr.microsoft.com/playwright:v1.63.0-noble",
    imageId: "sha256:x",
    browser: "chromium",
    device: "Desktop Chrome",
    workflow: "review",
    target: "dev",
    state: "ready",
    driver: { playwright: "1.63.0", node: "v24.0.0" },
    limits: { containerMemory: "3g", containerCpus: "2", serverHeapMb: 1024 },
    timings: { preflight: 900 },
    seed: { digest: "a".repeat(64), environment: { clock: "real" } },
    source: { commit: "c", dirty: false, dirtyDigest: null },
    environment: { effective: { timezoneId: "UTC", locale: "en-US", now: "x" } },
    attempts: [{ batchId: "b", status: "failed" }],
    artifacts: [{ path: "batch-1/bundle/network.jsonl", kind: "network", bytes: 10, truncated: true }],
  };
  assert.deepEqual(validateManifest(valid), []);
  assert.ok(validateManifest({ ...valid, artifacts: [{ path: "x", bytes: 1 }] }).some((problem) => /artifacts\[0\]/.test(problem)));
  const broken = validateManifest({ ...valid, schema: 2, schemaVersion: undefined, state: "running", attempts: [{ batchId: "b", status: "ok" }] });
  assert.ok(broken.some((problem) => /schemaVersion/.test(problem)));
  assert.ok(broken.some((problem) => /state must be/.test(problem)));
  assert.ok(broken.some((problem) => /attempts\[0\]/.test(problem)));
});

test("artifact kinds come from the file name", () => {
  assert.equal(artifactKind("network.jsonl"), "network");
  assert.equal(artifactKind("screenshot.png"), "screenshot");
  assert.equal(artifactKind("effect-0-before.png"), "screenshot");
  assert.equal(artifactKind("aria.yml"), "aria");
  assert.equal(artifactKind("trace.zip"), "trace");
  assert.equal(artifactKind("manifest.json"), "manifest");
  assert.equal(artifactKind("source.js"), "source");
  assert.equal(artifactKind("notes.bin"), "other");
});

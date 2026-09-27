import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { headerProblems, headerRules, resolveHeaderPath } from "../src/smoke.mjs";
import { createStaticServer } from "../src/static-server.mjs";

test("header rules: the array form means /, the map form names paths and values", () => {
  assert.deepEqual(headerRules(["X-Content-Type-Options"]), [
    { pathname: "/", rules: [{ name: "x-content-type-options", match: null }] },
  ]);
  const [root, sw] = headerRules({
    "/": [{ name: "Content-Security-Policy", match: "script-src 'self'" }],
    "/sw.js": [{ name: "cache-control", match: /no-cache/ }],
  });
  assert.equal(root.rules[0].match.source, "script-src 'self'");
  assert.equal(sw.pathname, "/sw.js");
  assert.deepEqual(headerRules(undefined), [{ pathname: "/", rules: [] }]);
  assert.throws(() => headerRules({ "/": [{ match: "x" }] }), /each rule is a name/);
});

test("header problems name the path, the header and what it should have matched", () => {
  const headers = new Headers({ "content-security-policy": "default-src 'self'" });
  const [{ rules }] = headerRules({
    "/": [{ name: "content-security-policy", match: "script-src 'self'" }, "x-content-type-options"],
  });
  assert.deepEqual(headerProblems("/", headers, rules), [
    `/: content-security-policy "default-src 'self'" does not match /script-src 'self'/`,
    "/: missing x-content-type-options",
  ]);
  assert.deepEqual(headerProblems("/", new Headers({ "content-security-policy": "script-src 'self'", "x-content-type-options": "nosniff" }), rules), []);
});

test("a pattern path is checked on the first file the build has under it", async () => {
  const dist = await mkdtemp(path.join(os.tmpdir(), "wh-headers-"));
  try {
    await mkdir(path.join(dist, "assets"));
    await writeFile(path.join(dist, "assets/b.js"), "");
    await writeFile(path.join(dist, "assets/a.css"), "");
    assert.equal(await resolveHeaderPath(dist, "/assets/*"), "/assets/a.css");
    assert.equal(await resolveHeaderPath(dist, "/sw.js"), "/sw.js");
    assert.equal(await resolveHeaderPath(dist, "/missing/*"), null);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test("swap publishes another build on the same origin, with its own _headers", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "wh-swap-"));
  const [a, b] = [path.join(base, "a"), path.join(base, "b")];
  try {
    for (const [dir, body, header] of [[a, "A", "one"], [b, "B", "two"]]) {
      await mkdir(dir);
      await writeFile(path.join(dir, "index.html"), body);
      await writeFile(path.join(dir, "_headers"), `/*\n  X-Build: ${header}\n`);
    }
    const served = await createStaticServer({ dir: a, port: 0 });
    try {
      const before = await fetch(`${served.url}/`);
      assert.equal(await before.text(), "A");
      assert.equal(before.headers.get("x-build"), "one");
      await served.swap(b);
      const after = await fetch(`${served.url}/`);
      assert.equal(await after.text(), "B");
      assert.equal(after.headers.get("x-build"), "two");
      assert.equal(served.rules.length, 1);
      await rm(path.join(a, "index.html"));
      await assert.rejects(served.swap(a), /has no index\.html/);
      assert.equal(await (await fetch(`${served.url}/`)).text(), "B", "a refused swap keeps serving");
    } finally {
      await served.close();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

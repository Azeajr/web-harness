import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStaticServer, headersFor, parseHeaders } from "../src/static-server.mjs";

const HEADERS = `# comment
/*
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/secure/:page
  X-Robots-Tag: noindex
  ! X-Frame-Options
https://example.pages.dev/*
  X-Host-Only: yes
`;

test("_headers: splats, placeholders, detach and host patterns follow Pages semantics", () => {
  const rules = parseHeaders(HEADERS);
  assert.equal(rules.length, 4);
  assert.deepEqual(Object.fromEntries(headersFor(rules, "/")), {
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'",
  });
  assert.equal(headersFor(rules, "/assets/app.js").get("cache-control"), "public, max-age=31536000, immutable");
  const secure = headersFor(rules, "/secure/page");
  assert.equal(secure.get("x-robots-tag"), "noindex");
  assert.equal(secure.has("x-frame-options"), false);
  assert.equal(headersFor(rules, "/secure/a/b").has("x-robots-tag"), false);
  assert.equal([...headersFor(rules, "/x").keys()].includes("x-host-only"), false);
  assert.throws(() => parseHeaders("  X: before any pattern"), /before any URL pattern/);
  assert.throws(() => parseHeaders("/*\n  no-colon-here"), /Name: value/);
});

test("_headers: a header set by two rules is joined, as Pages does", () => {
  const rules = parseHeaders("/*\n  Link: </a.css>\n/page\n  Link: </b.css>\n");
  assert.equal(headersFor(rules, "/page").get("link"), "</a.css>, </b.css>");
});

async function fixture(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wh-static-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}

test("server applies _headers, falls back to the SPA shell, and never serves config files", async () => {
  const directory = await fixture({
    "index.html": "<p>shell</p>",
    "assets/app.js": "console.log(1)",
    "about.html": "<p>about</p>",
    "_headers": HEADERS,
    "sw.wasm": "\0asm",
  });
  const served = await createStaticServer({
    dir: directory,
    port: 0,
    identity: { root: "/repo", token: "t" },
    unservedPrefixes: ["/api/"],
  });
  try {
    const root = await fetch(`${served.url}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("x-frame-options"), "DENY");
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await root.text(), "<p>shell</p>");
    const asset = await fetch(`${served.url}/assets/app.js`);
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await (await fetch(`${served.url}/about`)).text(), "<p>about</p>");
    assert.equal((await fetch(`${served.url}/sw.wasm`)).headers.get("content-type"), "application/wasm");
    const deep = await fetch(`${served.url}/workout/today`);
    assert.equal(deep.status, 200);
    assert.equal(await deep.text(), "<p>shell</p>");
    assert.equal(await (await fetch(`${served.url}/_headers`)).text(), "<p>shell</p>");
    const api = await fetch(`${served.url}/api/changes`);
    assert.equal(api.status, 404);
    assert.equal((await api.json()).error, "not served by the static harness server");
    assert.deepEqual(await (await fetch(`${served.url}/__web-harness/identity`)).json(), {
      root: "/repo",
      token: "t",
    });
    assert.equal((await fetch(`${served.url}/`, { method: "POST" })).status, 405);
    const traversal = await fetch(`${served.url}/..%2f..%2fetc%2fpasswd`);
    assert.notEqual(await traversal.text(), (await import("node:fs")).readFileSync("/etc/passwd", "utf8"));
  } finally {
    await served.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a top-level 404.html turns SPA fallback into real 404s", async () => {
  const directory = await fixture({ "index.html": "shell", "404.html": "missing" });
  const served = await createStaticServer({ dir: directory, port: 0 });
  try {
    const response = await fetch(`${served.url}/nope`);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "missing");
    assert.equal((await fetch(`${served.url}/__web-harness/identity`)).status, 404);
  } finally {
    await served.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a build without index.html, or one that relies on unemulated _redirects", async () => {
  const empty = await fixture({ "app.js": "" });
  const redirects = await fixture({ "index.html": "", "_redirects": "/a /b 301" });
  try {
    await assert.rejects(createStaticServer({ dir: empty, port: 0 }), /index\.html/);
    await assert.rejects(createStaticServer({ dir: redirects, port: 0 }), /_redirects/);
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(redirects, { recursive: true, force: true });
  }
});

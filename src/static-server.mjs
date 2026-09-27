import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { IDENTITY_PATH } from "./core.mjs";

// A local stand-in for Cloudflare Pages static asset serving, so every production-target check —
// Playwright E2E, the smoke, an agent's production session — sees the headers the deploy will send.
// `vite preview` does not read public/_headers; a project that copied its policy into
// `preview.headers` instead had two copies that could drift, and did.
//
// Deliberately NOT emulated: Pages Functions (answered 404 under `unservedPrefixes`), _redirects
// (refused, so the gap is loud), and edge caching. This proves the static bundle, not the edge.

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".ico", "image/x-icon"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".tsv", "text/tab-separated-values; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".pgn", "application/vnd.chess-pgn; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".ogg", "audio/ogg"],
  [".wav", "audio/wav"],
  [".map", "application/json; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"],
]);

// Pages config files are never served as assets.
const CONFIG_FILES = new Set(["/_headers", "/_redirects", "/_routes.json"]);

export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const pattern = raw.trim();
      current = { pattern, set: [], detach: [], matcher: patternMatcher(pattern) };
      rules.push(current);
      continue;
    }
    if (!current) throw new Error(`_headers line ${index + 1}: header before any URL pattern.`);
    const line = raw.trim();
    if (line.startsWith("!")) {
      current.detach.push(line.slice(1).trim().toLowerCase());
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`_headers line ${index + 1}: expected "Name: value".`);
    current.set.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

// Splats match anything, placeholders one segment. A pattern with a host applies to a deployed
// hostname this server does not have, so it never matches here.
function patternMatcher(pattern) {
  if (!pattern.startsWith("/")) return () => false;
  const regex = pattern
    .split(/(\*|:[A-Za-z_]\w*)/)
    .map((part) =>
      part === "*"
        ? ".*"
        : part.startsWith(":")
          ? "[^/]+"
          : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  const compiled = new RegExp(`^${regex}$`);
  return (pathname) => compiled.test(pathname);
}

// Every matching rule contributes; a header set twice is joined, as Pages does. A detach removes
// what earlier rules set.
export function headersFor(rules, pathname) {
  const headers = new Map();
  for (const rule of rules) {
    if (!rule.matcher(pathname)) continue;
    for (const name of rule.detach) headers.delete(name);
    for (const [name, value] of rule.set) {
      const key = name.toLowerCase();
      headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
    }
  }
  return headers;
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// Pages resolution: the exact file, then `.html`, then a directory index. A miss is the nearest
// 404.html with status 404, or — with no top-level 404.html — the SPA shell with status 200.
export async function resolveAsset(dir, pathname) {
  const relative = decodeURIComponent(pathname);
  if (relative.includes("\0")) return null;
  const target = path.resolve(dir, `.${relative}`);
  if (target !== dir && !target.startsWith(`${dir}${path.sep}`)) return null;
  // Pages config files are never assets: a request for one is an ordinary miss.
  const candidates = CONFIG_FILES.has(relative)
    ? []
    : relative.endsWith("/")
      ? [path.join(target, "index.html")]
      : [target, `${target}.html`, path.join(target, "index.html")];
  for (const candidate of candidates)
    if (await isFile(candidate)) return { file: candidate, status: 200 };
  for (let parent = path.dirname(target); parent.startsWith(dir); parent = path.dirname(parent)) {
    const notFound = path.join(parent, "404.html");
    if (await isFile(notFound)) return { file: notFound, status: 404 };
    if (parent === dir) break;
  }
  const shell = path.join(dir, "index.html");
  return (await isFile(shell)) ? { file: shell, status: 200 } : null;
}

// A build directory the server can serve: an index.html, no _redirects, and its _headers rules.
async function loadSite(dir) {
  const root = path.resolve(dir);
  if (!(await isFile(path.join(root, "index.html"))))
    throw new Error(`${root} has no index.html; build the app first.`);
  if (await isFile(path.join(root, "_redirects")))
    throw new Error("_redirects is not emulated by the harness server; extend it before relying on redirects.");
  let rules = [];
  try {
    rules = parseHeaders(await readFile(path.join(root, "_headers"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { root, rules };
}

export async function createStaticServer({
  dir,
  port,
  host = "127.0.0.1",
  identity = null,
  unservedPrefixes = [],
}) {
  // `swap` publishes another build on the same origin, as a deploy does: the smoke's update phase.
  let { root, rules } = await loadSite(dir);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      if (identity && url.pathname === IDENTITY_PATH) {
        response
          .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify(identity));
        return;
      }
      if (unservedPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
        response
          .writeHead(404, { "content-type": "application/json", "cache-control": "no-store" })
          .end(JSON.stringify({ error: "not served by the static harness server" }));
        return;
      }
      const asset = await resolveAsset(root, url.pathname);
      if (!asset) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
        return;
      }
      const headers = {
        "content-type": MIME.get(path.extname(asset.file).toLowerCase()) ?? "application/octet-stream",
        "cache-control": "public, max-age=0, must-revalidate",
        ...Object.fromEntries(headersFor(rules, url.pathname)),
      };
      const { size } = await stat(asset.file);
      headers["content-length"] = String(size);
      response.writeHead(asset.status, headers);
      if (request.method === "HEAD") response.end();
      else createReadStream(asset.file).pipe(response);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error.message));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    url: `http://${host}:${address.port}`,
    get rules() {
      return rules;
    },
    async swap(next) {
      ({ root, rules } = await loadSite(next));
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

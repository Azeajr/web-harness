import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { IDENTITY_META, IDENTITY_PATH } from "./core.mjs";

function projectRoot(start) {
  for (let directory = path.resolve(start); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, "harness.config.mjs"))) return realpathSync(directory);
    if (path.dirname(directory) === directory) return realpathSync(start);
  }
}

// Dev-server identity for the agent harness. The controller starts Vite with a token and checks
// it through /__web-harness/identity and a <meta> tag, so a session can never keep driving a
// server that was replaced on the same port, or one belonging to another worktree.
//
// Serve-only: nothing here reaches a production build. Without a harness token (plain `pnpm dev`)
// a random one is minted, so `web-harness start --url` can still verify the project root.
export function webHarness() {
  const token = process.env.WEB_HARNESS_TOKEN || randomUUID();
  let identity;
  return {
    name: "web-harness-identity",
    apply: "serve",
    config() {
      // A tab left open from an earlier server must not hot-reload against its replacement.
      return { server: { hmr: { path: `/__web-harness-hmr-${token}` } } };
    },
    configResolved(config) {
      identity = { root: process.env.WEB_HARNESS_ROOT || projectRoot(config.root), token };
    },
    transformIndexHtml() {
      return [{ tag: "meta", attrs: { name: IDENTITY_META, content: token }, injectTo: "head" }];
    },
    configureServer(server) {
      server.middlewares.use(IDENTITY_PATH, (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(identity));
      });
    },
  };
}

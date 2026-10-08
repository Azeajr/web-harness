import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createStaticServer } from "./static-server.mjs";

export const usage = `Usage: web-harness serve --port N [--dir dist] [--host 127.0.0.1] [--unserved PREFIX]...
Serve a build the way Cloudflare Pages does (public/_headers applied, SPA fallback): the Playwright
production webServer. Fails if the port is taken rather than moving elsewhere.
  --port N           Port to listen on (required)
  --dir DIR          Build output to serve (default dist)
  --host HOST        Address to bind (default 127.0.0.1)
  --unserved PREFIX  Answer 404 under this path prefix, e.g. /api/ for Pages Functions (repeatable)`;

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string", default: "dist" },
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      unserved: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  if (!values.port || !/^\d+$/.test(values.port)) throw new Error("serve requires --port.");
  const served = await createStaticServer({
    dir: values.dir,
    port: Number(values.port),
    host: values.host,
    identity: { root: await realpath(process.cwd()), token: process.env.WEB_HARNESS_TOKEN || randomUUID() },
    unservedPrefixes: values.unserved,
  });
  console.log(`web-harness serving ${values.dir} at ${served.url} (${served.rules.length} _headers rule(s))`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await served.close();
      process.exit(0);
    });
}

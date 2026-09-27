// The owned server process. A stable group leader lets the controller validate PID, start time,
// cwd and this entry path before it signals anything, so it can never stop a server it did not
// start. Dev targets spawn the adapter's command beneath it; production targets serve the build
// in-process with the Pages-style static server.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createStaticServer } from "./static-server.mjs";

const log = (event, detail = {}) => {
  const record = { at: new Date().toISOString(), event, pid: process.pid, ...detail };
  console.log(JSON.stringify(record));
  if (process.env.WEB_HARNESS_EVENTS)
    appendFileSync(process.env.WEB_HARNESS_EVENTS, JSON.stringify(record) + "\n");
};
const port = Number(process.env.WEB_HARNESS_PORT);
log("server-start", { port, target: process.env.WEB_HARNESS_TARGET });

if (process.env.WEB_HARNESS_TARGET === "production") {
  try {
    const served = await createStaticServer({
      dir: process.env.WEB_HARNESS_SERVE_DIR,
      port,
      identity: { root: process.env.WEB_HARNESS_ROOT, token: process.env.WEB_HARNESS_TOKEN },
      unservedPrefixes: JSON.parse(process.env.WEB_HARNESS_UNSERVED ?? "[]"),
    });
    log("server-ready", { url: served.url, rules: served.rules.length });
    process.on("SIGTERM", async () => {
      log("server-signal", { signal: "SIGTERM" });
      await served.close();
      process.exit(0);
    });
  } catch (error) {
    log("server-error", { message: error.message });
    process.exit(1);
  }
} else {
  const [command, ...args] = JSON.parse(process.env.WEB_HARNESS_COMMAND);
  const child = spawn(command, args, { cwd: process.env.WEB_HARNESS_CWD, stdio: "inherit" });
  child.on("error", (error) => {
    console.error(error.message);
    log("server-error", { message: error.message });
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    log("server-exit", { childPid: child.pid, code, signal });
    process.exitCode = code ?? 1;
  });
  // The controller signals this owned process group, including the package manager and Vite.
  process.on("SIGTERM", () => log("server-signal", { signal: "SIGTERM" }));
}

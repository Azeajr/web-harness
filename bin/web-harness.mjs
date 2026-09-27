#!/usr/bin/env node
// Entry point. Tooling commands (serve, smoke, e2e, mutate, scenarios, digest, skill, promote) are
// one-shot; everything else is the session controller.
import { toolCommands } from "../src/core.mjs";

const [command, ...rest] = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");

try {
  if (Object.hasOwn(toolCommands, command))
    await (await import(`../src/${toolCommands[command]}`)).main(rest);
  else await (await import("../src/controller.mjs")).main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
// Entry point. Tooling commands (serve, smoke, e2e, mutate, scenarios, digest, skill, promote,
// bench, mutation-score) are one-shot; everything else is the session controller.
import { asksForHelp, toolArguments, toolCommands } from "../src/core.mjs";

const [command, ...rest] = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");

try {
  if (Object.hasOwn(toolCommands, command)) {
    const tool = await import(`../src/${toolCommands[command]}`);
    const args = toolArguments(rest);
    // Usage and nothing else: answered before the tool reads its config or starts anything.
    if (asksForHelp(args)) console.log(tool.usage);
    else await tool.main(args);
  } else await (await import("../src/controller.mjs")).main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

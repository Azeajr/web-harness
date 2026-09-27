#!/usr/bin/env node
// Entry point. Tooling commands (serve, smoke, e2e, mutate, scenarios, digest) are one-shot;
// everything else is the session controller.
const [command, ...rest] = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");

const tools = {
  serve: () => import("../src/serve-cli.mjs"),
  smoke: () => import("../src/smoke.mjs"),
  e2e: () => import("../src/container.mjs"),
  mutate: () => import("../src/mutate.mjs"),
  scenarios: () => import("../src/scenarios.mjs"),
  digest: () => import("../src/digest-cli.mjs"),
};

try {
  if (tools[command]) await (await tools[command]()).main(rest);
  else await (await import("../src/controller.mjs")).main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

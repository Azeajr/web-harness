import { harnessPlaywright, productionServer } from "@azeajr/web-harness/playwright";
import { defineConfig, devices } from "playwright/test";
import harness from "./harness.config.mjs";

const port = 4192;

export default defineConfig({
  ...harnessPlaywright(harness, { use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` } }),
  testDir: "tests/e2e",
  workers: 1,
  webServer: productionServer({ port, build: "npx --no-install vite build", unserved: ["/api/"] }),
});

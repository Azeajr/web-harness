import { productionServer } from "@azeajr/web-harness/playwright";
import { defineConfig, devices } from "playwright/test";

const port = 4192;

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${port}` },
  webServer: productionServer({ port, build: "npx --no-install vite build", unserved: ["/api/"] }),
});

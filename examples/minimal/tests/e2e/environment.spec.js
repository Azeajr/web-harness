import { expect, test } from "./fixtures.js";

// harnessPlaywright applies the harness environment; `web-harness e2e --timezone X` overrides it.
test("runs in the requested timezone and locale", async ({ page }) => {
  await page.goto("/");
  const environment = await page.evaluate(() => ({
    timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
  }));
  expect(environment).toEqual({
    timezoneId: process.env.WEB_HARNESS_TIMEZONE || "UTC",
    locale: process.env.WEB_HARNESS_LOCALE || "en-US",
  });
});

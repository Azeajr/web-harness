import { expect, test } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("saves a note that survives a reload", async ({ page }) => {
  await page.getByRole("textbox", { name: "Note" }).fill("remember this");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#saved")).toHaveText("remember this");
  await page.reload();
  await expect(page.locator("#saved")).toHaveText("remember this");
});

test("an induced failure is expected, not ignored", async ({ page, expectPageFault }) => {
  expectPageFault("console.error", /induced failure/);
  expectPageFault("http", /missing\.json/);
  const missing = page.waitForResponse("**/missing.json");
  await page.getByRole("button", { name: "Break" }).click();
  await missing;
});

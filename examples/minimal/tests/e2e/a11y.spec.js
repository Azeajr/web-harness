import { expect, test } from "./fixtures.js";

// checkA11y scans the page as it is now; its findings are judged with every other fault at the end
// of the test, so an expected one is declared like any other.
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("the page passes the accessibility scan", async ({ checkA11y }) => {
  const scan = await checkA11y();
  expect(scan.faults).toEqual([]);
});

test("an icon button without a name is an a11y fault", async ({ page, checkA11y, expectPageFault }) => {
  expectPageFault("a11y", /button-name/);
  await page.locator("#clear").evaluate((button) => button.removeAttribute("aria-label"));
  const scan = await checkA11y();
  expect(scan.faults.map((fault) => fault.rule)).toContain("button-name");
});

test("a disabled rule excuses the finding but keeps it", async ({ page, checkA11y }) => {
  await page.locator("#clear").evaluate((button) => button.removeAttribute("aria-label"));
  const scan = await checkA11y({ disable: ["button-name"] });
  expect(scan.faults.find((fault) => fault.rule === "button-name")?.excusedBy).toBe("a11y.disable");
});

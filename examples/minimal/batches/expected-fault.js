// Exercising a failure path on purpose: the faults Break causes are expected by this batch alone.
// Without expectFault the batch would fail; if Break stopped failing, it would fail too.
async (page, { step, expectFault }) => {
  expectFault("console.error", /induced failure/);
  expectFault("http", /missing\.json/);
  await step("press Break", async () => {
    const missing = page.waitForResponse(/missing\.json/);
    await page.getByRole("button", { name: "Break" }).click();
    await missing;
  });
  return "failure path exercised";
}

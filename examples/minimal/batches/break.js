// A failing journey: Break logs a console error and requests a missing file. Nothing in the batch
// throws, but the retained faults fail it, with a screenshot and state kept as evidence.
async (page, { step }) => {
  await step("press Break", async () => {
    const missing = page.waitForResponse(/missing\.json/);
    await page.getByRole("button", { name: "Break" }).click();
    await missing;
  });
  return "pressed";
}

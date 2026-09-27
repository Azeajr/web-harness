// A passing journey: save through the visible form, then confirm it with the dev state accessor.
// Run with: web-harness run batches/save.js
async (page, { step, assert, observe, state }) => {
  await step("type and save", async () => {
    await page.getByRole("textbox", { name: "Note" }).fill("from a batch");
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator("#saved").filter({ hasText: "from a batch" }).waitFor();
  });
  const saved = await step("read back", () => state(["note"]));
  assert(saved.note?.text === "from a batch", `state says ${JSON.stringify(saved)}`);
  return { note: saved.note, region: await observe("#saved") };
}

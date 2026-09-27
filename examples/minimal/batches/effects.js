// `effect` around real actions: a save must change the durable note, a disabled control and a
// cancelled dialog must change nothing. Run with: web-harness run batches/effects.js
async (page, { effect }) => {
  await effect(
    "save a note",
    async () => {
      await page.getByRole("textbox", { name: "Note" }).fill("changed by effect");
      await page.getByRole("button", { name: "Save" }).click();
    },
    {
      observe: ["#saved"],
      durable: true,
      settle: (page) => page.locator("#saved").filter({ hasText: "changed by effect" }).waitFor(),
      expect: { "durable.note.text": "changed by effect", "durable.note.revision": (now, then) => now === (then ?? 0) + 1 },
    },
  );
  await effect(
    "cancel the delete dialog",
    async () => {
      await page.getByRole("button", { name: "Delete…" }).click();
      await page.getByRole("button", { name: "Cancel" }).click();
    },
    { observe: ["#saved"], durable: true, expect: "none" },
  );
  return "effects held";
}

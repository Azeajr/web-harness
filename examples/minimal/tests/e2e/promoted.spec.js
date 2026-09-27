// Promoted from batches/effects.js by `web-harness promote`.
// The batch runs unchanged: step is test.step, assert is expect, faults go through the same guard,
// and the page is seeded with the "blank" fixture exactly as a session is.
import { applyHarnessFixture, batchHelpers } from "@azeajr/web-harness/playwright";
import harness from "../../harness.config.mjs";
import { expect, test } from "./fixtures.js";

/** @type {import("@azeajr/web-harness/playwright").HarnessBatch} */
const batch =
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
};

test("a save changes the note and a cancel changes nothing", async ({ page, allowPageFaults, expectPageFault }) => {
  await applyHarnessFixture(page, harness, "blank");
  const helpers = batchHelpers(page, harness, { test, expect, allowPageFaults, expectPageFault, target: "production" });
  const result = await batch(page, helpers);
  await test.info().attach("batch-result.json", {
    body: JSON.stringify(result ?? null, null, 2),
    contentType: "application/json",
  });
});

// The quiet no-op: Archive is disabled, so pressing it (by script, as a buggy handler might) changes
// nothing. `expect: "change"` turns that silence into a failure.
async (page, { effect }) => {
  await effect(
    "archive the note",
    () => page.locator("#archive").evaluate((button) => button.click()),
    { observe: ["#saved", "#status"], durable: true, expect: "change" },
  );
}

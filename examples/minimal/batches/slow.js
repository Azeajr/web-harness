// Outlives a short WEB_HARNESS_CLI_TIMEOUT_MS on purpose: the controller cannot know what it did,
// so the next `run` is refused until `web-harness reconcile` looks at the page.
async (page) => {
  await page.waitForTimeout(8000);
  return "slow";
}

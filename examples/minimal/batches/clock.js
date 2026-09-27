// Moves an installed clock: start the session with --clock install --now ISO. The page's own timers
// (a rest timer, a day rollover) run only when the batch says so.
async (page, { step, clock }) => {
  await step("pause at half past", () => clock.pauseAt("2026-03-08T07:30:00Z"));
  await step("one minute later", () => clock.fastForward("01:00"));
  return page.evaluate(() => ({
    now: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
}

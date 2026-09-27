// SERIALIZED. The `clock` a batch (and a promoted test) receives. Timers move only under an
// installed clock (environment.clock "install"); a call that needs another mode says which, rather
// than surfacing Playwright's generic error.
//
// A pause lasts for the batch. The Playwright CLI settles after every command by waiting on a
// setTimeout inside the page, which a paused clock never fires: a session left paused would hang
// on its next command. `release()` resumes a clock this helper paused; the batch runner calls it
// when the batch ends, and time flows on from the paused instant.
export function clockHelper(page, mode) {
  let paused = false;
  const needsInstall = (name, action) => async (...args) => {
    if (mode !== "install")
      throw new Error("clock." + name + ' needs environment.clock "install" (this session: ' + mode + ").");
    return action(...args);
  };
  return {
    mode,
    runFor: needsInstall("runFor", (ms) => page.clock.runFor(ms)),
    fastForward: needsInstall("fastForward", (ms) => page.clock.fastForward(ms)),
    pauseAt: needsInstall("pauseAt", async (time) => {
      await page.clock.pauseAt(new Date(time));
      paused = true;
    }),
    resume: needsInstall("resume", async () => {
      await page.clock.resume();
      paused = false;
    }),
    setFixedTime: async (time) => {
      if (mode === "real") throw new Error('clock.setFixedTime needs environment.clock "fixed" or "install" (this session: real).');
      return page.clock.setFixedTime(new Date(time));
    },
    now: () => page.evaluate(() => Date.now()),
    release: async () => {
      if (!paused) return false;
      await page.clock.resume();
      paused = false;
      return true;
    },
  };
}

// SERIALIZED. Pin the page clock the way a session does, before the first navigation.
export async function applyClock(page, environment) {
  if (environment.clock === "fixed") await page.clock.setFixedTime(new Date(environment.now));
  else if (environment.clock === "install") await page.clock.install({ time: new Date(environment.now) });
  return environment.clock;
}

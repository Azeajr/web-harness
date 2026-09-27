import {
  STUB_EXTERNAL,
  consoleKind,
  describeConsole,
  isExternal,
  isUnserved,
  isUnservedLoad,
} from "./faults.mjs";

// Wire a BrowserContext to the fault policy: page errors, crashes, failing console output,
// failed or erroring same-origin requests, and escaped external calls (stubbed, and recorded
// unless the policy says stub-only). Used by the Playwright fixture and the production smoke;
// the controller's installPolicy is the serialized twin of this and classifies with the same
// functions from faults.mjs.
export async function watchContext(target, { policy, origin, record, warn = () => {}, initScript }) {
  const attach = (page) => {
    page.on("pageerror", (error) => record("pageerror", `${error.name}: ${error.message}`));
    page.on("crash", () => record("crash", "Browser page crashed"));
    page.on("console", (message) => {
      const detail = describeConsole(message.text(), message.location());
      const kind = consoleKind(message.type(), detail, policy);
      // The browser's own "Failed to load resource" line for an unserved path is the same event as
      // the 404 excused below, not a second fault.
      if (kind === "warning" || (kind && isUnservedLoad(message.text(), message.location(), origin, policy)))
        warn(detail);
      else if (kind) record(kind, detail);
    });
  };
  // Without an app origin to compare with, anything not on localhost is external.
  const external = (url) =>
    origin
      ? isExternal(url, origin)
      : ["http:", "https:"].includes(new URL(url).protocol) &&
        !["127.0.0.1", "localhost"].includes(new URL(url).hostname);
  target.pages().forEach(attach);
  target.on("page", attach);
  target.on("requestfailed", (request) => {
    if (origin && isUnserved(request.url(), origin, policy)) return;
    // A service worker's own fetch is marked: offline, its network attempt failing is how a
    // network-first strategy falls back to cache, while a PAGE request failing is a missing
    // precache entry. Chromium only; elsewhere serviceWorker() is absent or null.
    const sw = request.serviceWorker?.() ? "sw " : "";
    record(
      "requestfailed",
      `${sw}${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
    );
  });
  target.on("response", (response) => {
    if (!origin || new URL(response.url()).origin !== origin) return;
    if (isUnserved(response.url(), origin, policy)) return;
    if (response.status() >= policy.httpErrorStatus)
      record("http", `${response.status()} ${response.url()}`);
  });
  await target.route(
    (url) => external(url.href),
    async (route) => {
      const detail = `${route.request().method()} ${route.request().url()}`;
      if (policy.external === "fault") record("external", detail);
      else warn(`external (stubbed): ${detail}`);
      await route.fulfill(STUB_EXTERNAL);
    },
  );
  if (initScript) await target.addInitScript({ content: `(${initScript.toString()})();` });
}

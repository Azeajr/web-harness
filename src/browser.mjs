/* global window, document, getComputedStyle */

// Everything here is serialized into Playwright CLI run-code with toString(): no imports, no
// module scope. Helpers arrive as the `lib` argument, compiled from src/faults.mjs by the
// controller, so the browser session classifies faults with the exact functions tests use.

// Faults are retained on the BrowserContext because CLI network logs are scoped to navigation: a
// later reload must not erase a failed request from the reviewed journey.
export async function installPolicy(page, config, lib) {
  const context = page.context();
  if (context.__webHarnessFaults)
    throw new Error("Policy already installed; reset the profile first.");
  context.__webHarnessFaults = [];
  context.__webHarnessWarnings = [];
  const { policy, origin } = config;
  const record = (kind, detail) =>
    context.__webHarnessFaults.push({ at: new Date().toISOString(), kind, detail });
  const warn = (detail, location) =>
    context.__webHarnessWarnings.push({ at: new Date().toISOString(), detail, location });
  const attach = (target) => {
    target.on("console", (message) => {
      const detail = lib.describeConsole(message.text(), message.location());
      const kind = lib.consoleKind(message.type(), detail, policy);
      if (
        kind === "warning" ||
        (kind && lib.isUnservedLoad(message.text(), message.location(), origin, policy))
      )
        warn(detail, message.location());
      else if (kind) record(kind, detail);
    });
    target.on("pageerror", (error) => record("pageerror", `${error.name}: ${error.message}`));
    target.on("crash", () => record("crash", "Browser page crashed"));
  };
  context.pages().forEach(attach);
  context.on("page", attach);
  context.on("requestfailed", (request) => {
    // An aborted navigation guard is recorded as infrastructure below; do not count it twice.
    if (request.failure()?.errorText === "net::ERR_BLOCKED_BY_CLIENT") return;
    record("requestfailed", `${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  context.on("response", (response) => {
    if (lib.isUnserved(response.url(), origin, policy)) return;
    if (response.status() >= policy.httpErrorStatus)
      record("http", `${response.status()} ${response.url()}`);
  });
  await context.route(
    (url) => lib.isExternal(url.href, origin),
    async (route) => {
      const detail = `${route.request().method()} ${route.request().url()}`;
      if (policy.external === "fault") record("external", detail);
      else warn(`external (stubbed): ${detail}`);
      await route.fulfill(lib.STUB_EXTERNAL);
    },
  );
  // Guard automatic reloads as well as explicit CLI navigation after a server turnover.
  await context.route(
    (url) => url.origin === origin,
    async (route) => {
      const request = route.request();
      if (lib.isUnserved(request.url(), origin, policy)) {
        warn(`unserved: ${request.method()} ${request.url()}`);
        return route.continue();
      }
      if (!request.isNavigationRequest()) return route.continue();
      try {
        const response = await context.request.get(config.identityUrl, { timeout: 2_000 });
        const identity = await response.json();
        if (
          !response.ok() ||
          identity.root !== config.identity.root ||
          identity.token !== config.identity.token
        )
          throw new Error("Review server identity changed; stop/start to reseed.");
        await route.continue();
      } catch (error) {
        record("infrastructure", error.message);
        await route.abort("blockedbyclient");
      }
    },
  );
  if (config.initScript) await context.addInitScript({ content: `(${config.initScript})();` });
  return { policy: "installed" };
}

// Navigate, wait for the adapter's readiness condition, apply the fixture through the adapter's
// own function, and return postconditions. `fixture.apply` and `ready` are adapter sources.
export async function applyFixture(page, fixture, lib) {
  await page.goto(fixture.url, { waitUntil: "domcontentloaded" });
  if (lib.ready) await lib.ready(page);
  const applied = lib.apply
    ? await lib.apply(page, fixture.data, { dataFile: fixture.dataFile ?? null })
    : null;
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  if (lib.ready) await lib.ready(page);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));
  return { url: page.url(), viewport, applied: applied ?? null };
}

// A --full-page capture grows with the PAGE. A pane that scrolls inside itself keeps its offscreen
// content out of the image, so the capture equals the viewport shot and looks complete while it is
// not. Report those panes so the reviewer scrolls and captures them instead of trusting the image.
export async function scanClippedRegions(page) {
  return page.evaluate(() => {
    const slack = 2; // sub-pixel rounding from device scale factors, not real hidden content
    const label = (element) => {
      const described =
        element.getAttribute("aria-label") ??
        element
          .getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
      if (described?.trim()) return described.trim().slice(0, 60);
      const heading = element.querySelector("h1, h2, h3, h4, h5, h6");
      if (heading?.textContent?.trim()) return heading.textContent.trim().slice(0, 60);
      return element.className?.toString().split(/\s+/)[0] || element.tagName.toLowerCase();
    };
    const regions = [];
    for (const element of document.querySelectorAll("*")) {
      if (element === document.body || element === document.documentElement) continue;
      if (element.offsetParent === null) continue; // display:none or detached
      const hidden = element.scrollHeight - element.clientHeight;
      if (hidden <= slack) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden") continue;
      if (!["auto", "scroll", "overlay"].includes(style.overflowY)) continue;
      regions.push({ name: label(element), hidden, shown: element.clientHeight });
    }
    return regions;
  });
}

// Menus, dialogs, tooltips and listboxes that render outside the viewport are unreachable on a
// phone however the rest of the layout looks. Reported by `check` as layout-overflow faults.
export async function scanOverlayOverflow(page) {
  return page.evaluate(() => {
    const selector =
      '[role="menu"], [role="menuitem"], [role="dialog"], [role="alertdialog"], ' +
      '[role="tooltip"], [role="listbox"], [role="option"]';
    const slack = 1; // sub-pixel rounding from device scale factors, not real overflow
    const found = [];
    for (const el of document.querySelectorAll(selector)) {
      if (el.offsetParent === null) continue; // display:none or detached
      const style = getComputedStyle(el);
      if (style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (
        rect.left < -slack ||
        rect.top < -slack ||
        rect.right > window.innerWidth + slack ||
        rect.bottom > window.innerHeight + slack
      ) {
        found.push({
          role: el.getAttribute("role"),
          name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80),
          rect: {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            right: Math.round(rect.right),
            bottom: Math.round(rect.bottom),
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
      }
    }
    return found;
  });
}

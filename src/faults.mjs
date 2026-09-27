// One fault policy for exploration (the controller) and regression (Playwright tests). Both read
// the adapter's `faults` block through faultPolicy() and classify with the same functions, so a
// fault that fails a test also fails a review session, and an excuse granted in one is granted in
// the other. The classifiers are self-contained: the controller serializes them with toString()
// into Playwright CLI run-code, where nothing from this module's scope exists.

// Noise everywhere, excused in one place. Browsers report a resize handler that triggers another
// resize through window.onerror and recover on the next frame; both spellings are in the wild.
export const DEFAULT_ALLOWED = [
  "ResizeObserver loop (completed with undelivered notifications|limit exceeded)",
];

// Only what the page says can be excused by pattern. A failed request, a crash, an HTTP error or
// an escaped external call is never "noise": a test that causes one on purpose declares it.
export const EXCUSABLE_KINDS = ["pageerror", "console.error", "console.warning"];

const source = (pattern, label) => {
  if (pattern instanceof RegExp) {
    if (pattern.flags.replace("u", "")) throw new Error(`${label} patterns may not use flags.`);
    return pattern.source;
  }
  if (typeof pattern !== "string" || !pattern) throw new Error(`${label} patterns must be strings.`);
  new RegExp(pattern); // reject malformed input here, not inside the browser
  return pattern;
};

export function faultPolicy(config = {}) {
  const allowed = config.allowed ?? [];
  const watchedWarnings = config.watchedWarnings ?? [];
  if (!Array.isArray(allowed) || !Array.isArray(watchedWarnings))
    throw new Error("faults.allowed and faults.watchedWarnings must be arrays.");
  const external = config.external ?? "fault";
  if (!["fault", "stub"].includes(external))
    throw new Error('faults.external must be "fault" (stub and record) or "stub" (stub only).');
  return {
    allowed: [...DEFAULT_ALLOWED, ...allowed.map((pattern) => source(pattern, "faults.allowed"))],
    watchedWarnings: watchedWarnings.map((pattern) => source(pattern, "faults.watchedWarnings")),
    external,
    // Same-origin responses at or above this status are faults. A 404 for a missing asset is
    // exactly the defect a production build check exists to catch.
    httpErrorStatus: config.httpErrorStatus ?? 400,
    // Paths the static host does not serve (Cloudflare Pages Functions, say). Requests to them are
    // answered 404 by the harness server and are not faults: the app is offline-first and its
    // callers already handle an unreachable API. Prefixes, same origin only.
    unservedPrefixes: config.unservedPrefixes ?? [],
  };
}

// Returns the fault kind for a console message, "warning" for an ordinary warning worth keeping as
// evidence, or null. Self-contained: serialized into the browser tooling.
export function consoleKind(type, text, policy) {
  if (type === "error") return "console.error";
  if (type === "warning")
    return policy.watchedWarnings.some((pattern) => new RegExp(pattern).test(text))
      ? "console.warning"
      : "warning";
  return null;
}

// A console message plus where it came from. The location is part of what patterns match on, so
// it belongs in the matched string and not only in the reported one.
export function describeConsole(text, location) {
  return `${text}${location?.url ? ` (${location.url}:${location.lineNumber})` : ""}`;
}

// Playwright CLI run-code has no URL global, so these parse the one part they need by hand.
// Self-contained: serialized into the browser tooling.
export function isExternal(url, origin) {
  const match = /^(https?):\/\/([^/?#]*)/i.exec(url);
  if (!match) return false; // data:, blob:, about: and friends never leave the page
  return `${match[1]}://${match[2]}`.toLowerCase() !== origin.toLowerCase();
}

export function isUnserved(url, origin, policy) {
  const match = /^(https?:\/\/[^/?#]*)(\/[^?#]*)?/i.exec(url);
  if (!match || match[1].toLowerCase() !== origin.toLowerCase()) return false;
  const pathname = match[2] ?? "/";
  return policy.unservedPrefixes.some((prefix) => pathname.startsWith(prefix));
}

// The console line a browser prints for a failed load of an unserved path. Self-contained (it
// repeats isUnserved's parse rather than calling it: serialized, there is no module to call into).
export function isUnservedLoad(text, location, origin, policy) {
  if (!origin || !location?.url || !/^Failed to load resource/.test(text)) return false;
  const match = /^(https?:\/\/[^/?#]*)(\/[^?#]*)?/i.exec(location.url);
  if (!match || match[1].toLowerCase() !== origin.toLowerCase()) return false;
  const pathname = match[2] ?? "/";
  return policy.unservedPrefixes.some((prefix) => pathname.startsWith(prefix));
}

// Faults that remain after excuses. Project-wide allowances excuse only what the page says;
// `local` holds one test's or scenario's own declared allowances, which may name any kind — a
// test that aborts a route on purpose excuses that request failure, for that test alone. A record
// a batch already excused (`excusedBy`) stays in the evidence and never counts again.
// Self-contained: serialized into batch run-code.
export function failures(records, policy, local = []) {
  if (!Array.isArray(records)) throw new Error("Fault collector is missing. Reset the session.");
  const excusable = ["pageerror", "console.error", "console.warning"];
  const global = policy.allowed.map((pattern) => new RegExp(pattern));
  const scoped = local.map((pattern) => new RegExp(pattern));
  return records.filter(
    (record) =>
      !(
        record.excusedBy ||
        (excusable.includes(record.kind) && global.some((pattern) => pattern.test(record.detail))) ||
        scoped.some((pattern) => pattern.test(record.detail))
      ),
  );
}

// Expected faults are scenario-local and counted: each must match at least once, or the scenario
// did not exercise the failure path it claims to.
export function unmetExpectations(records, expected) {
  return expected.filter(
    ({ kind, pattern }) =>
      !records.some(
        (record) => (!kind || record.kind === kind) && new RegExp(pattern).test(record.detail),
      ),
  );
}

// The response a stubbed external call receives. JSON null is "no data" to a well-behaved client:
// the same path it takes against an unreachable service, minus the network. The permissive CORS
// headers matter because WebKit reports a failed access-control check as a page error rather than
// letting fetch reject into the caller's catch.
export const STUB_EXTERNAL = {
  status: 200,
  contentType: "application/json",
  headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  },
  body: "null",
};

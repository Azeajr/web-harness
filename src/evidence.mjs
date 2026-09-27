// Failure evidence: what a failed journey leaves behind so it can be explained without replaying
// it. The browser side (rings of requests and console messages kept on the BrowserContext, the
// capture run at a failure) is serialized into Playwright CLI run-code by the controller and used
// directly by the Playwright fixture and the smoke; the Node side writes the bundle directory.
//
// Functions marked SERIALIZED are shipped with toString(): self-contained, no URL or Buffer.

export const REQUEST_CAP = 2000;
export const CONSOLE_CAP = 1000;
export const CONTEXT_BEFORE = 50;

// Query parameters whose values never reach evidence. Extended by the project's evidence.redact.
export const DEFAULT_REDACT_QUERY = ["token", "secret", "key", "code", "pair", "auth", "password", "session"];

// SERIALIZED. Values of matching query parameters become [redacted]; the rest of the URL stays.
export function redactUrl(url, patterns) {
  const text = String(url);
  const query = text.indexOf("?");
  if (query < 0) return text;
  const hash = text.indexOf("#", query);
  const end = hash < 0 ? text.length : hash;
  const params = text
    .slice(query + 1, end)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals < 0) return pair;
      const name = pair.slice(0, equals);
      return patterns.some((pattern) => new RegExp(pattern, "i").test(name))
        ? `${name}=[redacted]`
        : pair;
    });
  return `${text.slice(0, query)}?${params.join("&")}${text.slice(end)}`;
}

// SERIALIZED. A bounded list on the context: the oldest entry makes way, and is counted.
export function pushRing(ring, entry, cap) {
  if (ring.entries.length >= cap) {
    ring.entries.shift();
    ring.dropped++;
  }
  ring.entries.push(entry);
  return entry;
}

// SERIALIZED. Install the request and console rings on a context (idempotent) and return them.
// `lib` supplies redactUrl and pushRing (they cannot be called by name once serialized).
export function installEvidence(context, options, lib) {
  if (context.__webHarnessEvidence) return context.__webHarnessEvidence;
  const evidence = {
    seq: 0,
    requests: { entries: [], dropped: 0 },
    console: { entries: [], dropped: 0 },
  };
  context.__webHarnessEvidence = evidence;
  const redact = options.redactQuery ?? [];
  const pending = new WeakMap();
  const now = () => new Date().toISOString();
  context.on("request", (request) => {
    let fromServiceWorker = false;
    try {
      fromServiceWorker = Boolean(request.serviceWorker?.());
    } catch {
      /* not Chromium */
    }
    const entry = lib.pushRing(
      evidence.requests,
      {
        seq: ++evidence.seq,
        at: now(),
        method: request.method(),
        url: lib.redactUrl(request.url(), redact).slice(0, 500),
        resourceType: request.resourceType(),
        fromServiceWorker,
        status: null,
        failure: null,
        ms: null,
      },
      options.requestCap,
    );
    pending.set(request, { entry, started: Date.now() });
  });
  context.on("response", (response) => {
    const item = pending.get(response.request());
    if (item) item.entry.status = response.status();
  });
  context.on("requestfinished", (request) => {
    const item = pending.get(request);
    if (item) item.entry.ms = Date.now() - item.started;
  });
  context.on("requestfailed", (request) => {
    const item = pending.get(request);
    if (!item) return;
    item.entry.failure = request.failure()?.errorText ?? "failed";
    item.entry.ms = Date.now() - item.started;
  });
  const attach = (page) =>
    page.on("console", (message) => {
      const location = message.location();
      lib.pushRing(
        evidence.console,
        {
          seq: ++evidence.seq,
          at: now(),
          type: message.type(),
          text: message.text().slice(0, 500),
          location: location?.url
            ? `${lib.redactUrl(location.url, redact)}:${location.lineNumber}`
            : null,
        },
        options.consoleCap,
      );
    });
  context.pages().forEach(attach);
  context.on("page", attach);
  return evidence;
}

// SERIALIZED. Entries from `mark` on, plus up to `before` earlier ones for context.
export function sliceRing(ring, mark, before) {
  const index = ring.entries.findIndex((entry) => entry.seq > mark);
  const start = index < 0 ? ring.entries.length : index;
  return {
    entries: ring.entries.slice(Math.max(0, start - before)),
    dropped: ring.dropped,
    fromSeq: mark,
  };
}

// SERIALIZED. Storage and service-worker state as the page sees it: names and counts, never
// values. For an offline-first app this is usually where the explanation is.
export async function captureStorage(page) {
  return page.evaluate(async () => {
    const result = { url: location.href, viewport: { width: innerWidth, height: innerHeight } };
    const attempt = async (name, read) => {
      try {
        result[name] = await read();
      } catch (error) {
        result[name] = { error: String(error?.message ?? error).slice(0, 200) };
      }
    };
    await attempt("estimate", async () => {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    });
    await attempt("localStorageKeys", () => Object.keys(localStorage).slice(0, 100));
    await attempt("sessionStorageKeys", () => Object.keys(sessionStorage).slice(0, 100));
    await attempt("indexedDB", async () =>
      indexedDB.databases ? (await indexedDB.databases()).map(({ name, version }) => ({ name, version })) : "unsupported",
    );
    await attempt("caches", async () => (self.caches ? await caches.keys() : "unsupported"));
    await attempt("serviceWorker", async () => {
      if (!navigator.serviceWorker) return "unsupported";
      const registration = await navigator.serviceWorker.getRegistration();
      const describe = (worker) => (worker ? { scriptURL: worker.scriptURL, state: worker.state } : null);
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        registration: registration
          ? {
              scope: registration.scope,
              active: describe(registration.active),
              waiting: describe(registration.waiting),
              installing: describe(registration.installing),
            }
          : null,
      };
    });
    return result;
  });
}

// Node side. One ordered story: controller events, batch steps, faults, console lines and requests
// merged by time. Captures are sequential; nothing here is claimed to be simultaneous.
export function mergeTimeline({ events = [], steps = [], faults = [], console = [], requests = [] }, tags = {}) {
  const rows = [
    ...events.map((event) => ({ at: event.at, source: "controller", ...event })),
    ...steps.flatMap((step) => [
      { at: step.startedAt, source: "step", event: "start", name: step.name },
      { at: step.endedAt, source: "step", event: step.ok ? "end" : "failed", name: step.name, ms: step.ms },
    ]),
    ...faults.map((fault) => ({ at: fault.at, source: "fault", kind: fault.kind, detail: fault.detail, excused: Boolean(fault.excusedBy) })),
    ...console.map((line) => ({ at: line.at, source: "console", type: line.type, text: line.text, location: line.location })),
    ...requests.map((request) => ({
      at: request.at,
      source: "request",
      method: request.method,
      url: request.url,
      status: request.status,
      failure: request.failure,
      ms: request.ms,
      fromServiceWorker: request.fromServiceWorker,
    })),
  ].filter((row) => row.at);
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return rows.map((row) => ({ ...tags, ...row }));
}

// Node side. The gist of a failure for the agent's first read; the bundle has the rest.
export function summarizeFailure({ faults = [], requests = [], console = [], storage = null, url = null }) {
  const counted = faults.filter((fault) => !fault.excusedBy);
  const badRequests = requests.filter((request) => request.failure || (request.status ?? 0) >= 400);
  const errors = console.filter((line) => line.type === "error");
  const waiting = storage?.serviceWorker?.registration?.waiting ?? null;
  return {
    firstFault: counted[0] ? `${counted[0].kind}: ${String(counted[0].detail).slice(0, 300)}` : null,
    failedRequests: badRequests
      .slice(-3)
      .map((request) => `${request.method} ${request.url} → ${request.failure ?? request.status}`),
    lastConsoleError: errors.at(-1)?.text ?? null,
    url: url ?? storage?.url ?? null,
    waitingServiceWorker: waiting ? waiting.scriptURL : null,
  };
}

export const toJsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

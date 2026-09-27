// `effect`: read what is watched, act, settle, read again, and say what changed. The quiet no-op —
// a click that did nothing, or changed something other than what was meant — is the commonest
// mistake an agent's journey hides; a before/after diff exposes it. The reads are sequential and
// timestamped, never claimed to be one atomic snapshot.
//
// Everything here is SERIALIZED into Playwright CLI run-code (batches and the CLI form): no
// imports, no module scope; helpers arrive through `lib`.

export const DIFF_LIMIT = 50;
export const VALUE_LIMIT = 200;

// SERIALIZED. The stable parts of an observe() result. Focus, scroll offsets and boxes move for
// reasons of their own (a click focuses its button) and would make every "expect none" fail.
export function stableObservation(observation) {
  return {
    count: observation.count,
    elements: observation.elements.map((element) => ({
      text: element.text,
      visible: element.visible,
      attributes: element.attributes,
      css: element.css,
    })),
  };
}

// SERIALIZED. One read of everything watched. `lib` = { observe, readState, stateSpec, durable,
// stableObservation }. Unsupported reads are reported by name, not dropped.
export async function readWatched(page, watch, lib) {
  const snapshot = { values: {}, unsupported: [], at: new Date().toISOString() };
  if (watch.url !== false) snapshot.values.url = page.url();
  for (const selector of watch.observe ?? [])
    snapshot.values[`observe ${selector}`] = lib.stableObservation(
      await lib.observe(page, selector, { limit: 5, textLimit: 200, attributes: watch.attributes ?? [] }),
    );
  if (watch.state?.length) {
    const state = await lib.readState(page, watch.state, lib.stateSpec);
    if (state?.unsupported) snapshot.unsupported.push(`state: ${state.unsupported}`);
    else snapshot.values.state = state;
  }
  if (watch.durable) {
    if (!lib.durable) snapshot.unsupported.push("durable: this project registers no durable.read");
    else snapshot.values.durable = await lib.durable(page);
  }
  return snapshot;
}

// SERIALIZED. Flatten to path → JSON text (depth-bounded) and compare.
export function diffValues(before, after, limits) {
  const flatten = (value, prefix, out, depth) => {
    if (value && typeof value === "object" && depth < 8) {
      const keys = Array.isArray(value) ? value.map((_, index) => index) : Object.keys(value);
      if (!keys.length) out[prefix] = JSON.stringify(value);
      for (const key of keys) flatten(value[key], prefix ? `${prefix}.${key}` : String(key), out, depth + 1);
    } else out[prefix] = JSON.stringify(value) ?? "undefined";
    return out;
  };
  const a = flatten(before, "", {}, 0);
  const b = flatten(after, "", {}, 0);
  const cut = (text) => (text === undefined ? undefined : text.length > limits.value ? `${text.slice(0, limits.value)}…` : text);
  const changed = [];
  const unchanged = [];
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[path] === b[path]) unchanged.push(path);
    else changed.push({ path, before: cut(a[path]), after: cut(b[path]) });
  }
  return {
    changed: changed.slice(0, limits.entries),
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    truncated: changed.length > limits.entries,
  };
}

// SERIALIZED. Wait until the page is quiet: no same-origin request from after `mark` still in
// flight, then no DOM mutation for 150 ms (storage writes are invisible to the network check; their
// render is not), then two animation frames. With `until`, a selector that must become visible
// first — the deterministic way. Bounded; reports whether it settled rather than failing.
export async function settle(page, mark, timeoutMs, until) {
  const evidence = page.context().__webHarnessEvidence;
  const origin = page.url().replace(/^(https?:\/\/[^/]+).*$/, "$1");
  const deadline = Date.now() + timeoutMs;
  let quiet = false;
  if (until) {
    try {
      await page.locator(until).first().waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      return false;
    }
  }
  while (Date.now() < deadline) {
    const inFlight = (evidence?.requests.entries ?? []).filter(
      (entry) => entry.seq > mark && entry.url.startsWith(origin) && entry.ms === null && entry.failure === null,
    );
    if (!inFlight.length) {
      quiet = true;
      break;
    }
    // Playwright CLI run-code has no setTimeout (nor URL or Buffer): wait through the page.
    await page.waitForTimeout(50);
  }
  const remaining = Math.max(0, deadline - Date.now());
  const domQuiet = await page
    .evaluate(
      (limit) =>
        new Promise((resolve) => {
          let timer;
          const done = (value) => {
            observer.disconnect();
            clearTimeout(timer);
            clearTimeout(hard);
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(value)));
          };
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => done(true), 150);
          });
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          timer = setTimeout(() => done(true), 150);
          const hard = setTimeout(() => done(false), limit);
        }),
      Math.max(200, remaining),
    )
    .catch(() => false);
  return quiet && domQuiet;
}

// SERIALIZED. Check a diff against `expect`: "change", "none", or { path: value | (after, before) => bool }.
// Returns a failure message or null.
export function checkExpectation(name, expect, diff, before, after) {
  if (expect === undefined || expect === null) return null;
  if (expect === "change")
    return diff.changedCount ? null : `${name}: no watched change (${diff.unchangedCount} values compared).`;
  if (expect === "none")
    return diff.changedCount
      ? `${name}: expected no change, but ${diff.changed.map((item) => item.path).slice(0, 5).join(", ")} changed.`
      : null;
  const at = (object, path) => path.split(".").reduce((value, key) => (value == null ? value : value[key]), object);
  for (const [path, wanted] of Object.entries(expect)) {
    const now = at(after.values, path);
    const then = at(before.values, path);
    const ok = typeof wanted === "function" ? wanted(now, then) : JSON.stringify(now) === JSON.stringify(wanted);
    if (!ok) return `${name}: ${path} is ${JSON.stringify(now)?.slice(0, 200)} (was ${JSON.stringify(then)?.slice(0, 200)}).`;
  }
  return null;
}

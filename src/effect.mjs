// `effect`: read what is watched, act, settle, read again, and say what changed. The quiet no-op —
// a click that did nothing, or changed something other than what was meant — is the commonest
// mistake an agent's journey hides; a before/after diff exposes it. The reads are sequential and
// timestamped, never claimed to be one atomic snapshot.
//
// Everything here is SERIALIZED into Playwright CLI run-code (batches and the CLI form): no
// imports, no module scope; helpers arrive through `lib`.

export const DIFF_LIMIT = 50;
export const VALUE_LIMIT = 200;

// SERIALIZED. The parts of an observe() result a person sees: the match count and, per element,
// text, visibility, attributes, css, and whether it is on screen. A control whose whole effect is to
// scroll something into view (or away) changes only the last, so without it a reveal read as "no
// watched change" and an unexpected move passed `expect: "none"`.
// - inViewport, outsideViewport and clippedBy (the clipping or scrolling ancestors that cut it off,
//   per axis) flip only when an edge crosses the viewport or a pane. Layout is deterministic, so an
//   element that did not move does not flip them.
// - Its own scroll offsets, rounded to whole CSS pixels: scrolling a pane changes what it shows; a
//   fractional offset on a high-DPR screen does not.
// Left out on purpose: focus (a click focuses its button), the box, and scroll and client sizes.
// Coordinates shift by sub-pixels and with unrelated layout (a banner above, a web font, a scrollbar
// a modal hides) while the element stays on screen, which would make "expect none" flaky; rounding
// does not cure that (a 15 px scrollbar is not a rounding error, and a value near .5 still flips).
export function stableObservation(observation) {
  return {
    count: observation.count,
    elements: observation.elements.map((element) => ({
      text: element.text,
      visible: element.visible,
      inViewport: element.inViewport,
      outsideViewport: element.outsideViewport,
      // One value, e.g. "div:y main#workspace:xy" ("" when nothing clips it), so a reveal diffs as
      // one line rather than a path per ancestor field.
      clippedBy: element.clippedBy
        .map((clip) => `${clip.tag}${clip.id ? `#${clip.id}` : ""}:${clip.x ? "x" : ""}${clip.y ? "y" : ""}`)
        .join(" "),
      scroll: { left: Math.round(element.scroll.left), top: Math.round(element.scroll.top) },
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

// SERIALIZED. Flatten to path → JSON text (depth-bounded) and compare. `compared` counts the values
// compared per watched source (url, observe SEL, state, durable).
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
  // Per source, flattened on its own: a selector may itself contain dots.
  const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const leaves = (values, source) => (isRecord(values) && source in values ? flatten(values[source], source, {}, 1) : {});
  const compared = {};
  for (const source of new Set([before, after].flatMap((values) => (isRecord(values) ? Object.keys(values) : []))))
    compared[source] = Object.keys({ ...leaves(before, source), ...leaves(after, source) }).length;
  return {
    changed: changed.slice(0, limits.entries),
    changedCount: changed.length,
    unchangedCount: unchanged.length,
    truncated: changed.length > limits.entries,
    compared,
  };
}

// SERIALIZED. Wait until the page is quiet: no same-origin request from after `mark` still in
// flight, then no DOM mutation for 150 ms (storage writes are invisible to the network check; their
// render is not). With `until`, a selector that must become visible first — the deterministic way.
// Bounded; reports whether it settled rather than failing. Every wait is timed from Node, never by
// the page's clock, which a batch may have paused.
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
  // DOM quiet: no mutation for 150 ms. Counted in the page, timed from here: the page's own timers
  // and animation frames stop under an installed clock that is paused (clock.pauseAt), so a
  // setTimeout or requestAnimationFrame in the page would wait forever.
  const key = "__webHarnessSettle";
  const install = () =>
    page
      .evaluate((name) => {
        const state = { count: 0 };
        state.observer = new MutationObserver(() => state.count++);
        state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        window[name] = state;
        return 0;
      }, key)
      .catch(() => null);
  let domQuiet = false;
  let last = await install();
  let quietSince = Date.now();
  // At least one quiet window, even when the request wait used up the budget.
  const domDeadline = Math.max(deadline, quietSince + 200);
  while (last !== null && Date.now() < domDeadline) {
    await page.waitForTimeout(50);
    const count = await page.evaluate((name) => (window[name] ? window[name].count : -1), key).catch(() => null);
    // The page cannot be read (closed, crashed): not quiet, and no point waiting.
    if (count === null) break;
    if (count === -1) {
      // A navigation replaced the document: watch the new one.
      last = await install();
      quietSince = Date.now();
    } else if (count !== last) {
      last = count;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= 150) {
      domQuiet = true;
      break;
    }
  }
  await page
    .evaluate((name) => {
      window[name]?.observer.disconnect();
      delete window[name];
    }, key)
    .catch(() => null);
  return quiet && domQuiet;
}

// SERIALIZED. Check a diff against `expect`: "change", "none", or { path: value | (after, before) => bool }.
// Returns a failure message or null.
export function checkExpectation(name, expect, diff, before, after) {
  if (expect === undefined || expect === null) return null;
  if (expect === "change") {
    if (diff.changedCount) return null;
    // Say what was watched, so "no watched change" is not mistaken for "nothing changed".
    const count = diff.unchangedCount;
    const sources = Object.entries(diff.compared ?? {}).map(([source, n]) => `${source} ×${n}`);
    const observed = Object.keys(diff.compared ?? {}).some((source) => source.startsWith("observe "))
      ? " An observed element is compared by text, visible, inViewport, outsideViewport, clippedBy," +
        " scroll offsets, attributes and css, not by position, size or focus."
      : "";
    const listed = sources.length ? `: ${sources.join(", ")}` : "";
    return `${name}: no watched change (${count} value${count === 1 ? "" : "s"} compared${listed}).${observed}`;
  }
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

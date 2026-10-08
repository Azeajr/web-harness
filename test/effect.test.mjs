import assert from "node:assert/strict";
import test from "node:test";
import { checkExpectation, diffValues, readWatched, settle, stableObservation } from "../src/effect.mjs";
import { observe, readState } from "../src/inspect.mjs";

const limits = { entries: 50, value: 200 };

const rect = (x, y, width, height) => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height });

// A 375×629 phone: a scrolling pane below a 60 px header holds `.board-stage` (a card with 16 px
// gutters), which starts scrolled 823 px above the screen. A fake DOM run in Node, so the real observe() → stableObservation
// → diff chain is exercised without a browser.
function phone() {
  const pane = { tagName: "DIV", id: "", parentElement: null, rect: rect(0, 60, 375, 569), overflow: "auto" };
  const stage = {
    tagName: "SECTION",
    id: "",
    parentElement: pane,
    rect: rect(16, -823, 343, 375),
    overflow: "visible",
    innerText: "board",
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 343,
    scrollHeight: 375,
    clientWidth: 343,
    clientHeight: 375,
    getAttribute: () => null,
  };
  for (const element of [pane, stage]) element.getBoundingClientRect = () => element.rect;
  const page = {
    url: () => "http://127.0.0.1:1/",
    locator: (selector) => ({
      evaluateAll: async (fn, arg) => {
        const saved = { window: globalThis.window, document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
        Object.assign(globalThis, {
          window: { innerWidth: 375, innerHeight: 629, devicePixelRatio: 3 },
          document: { activeElement: null },
          getComputedStyle: (element) => ({
            visibility: "visible",
            display: "block",
            overflowX: element.overflow,
            overflowY: element.overflow,
            getPropertyValue: () => "",
          }),
        });
        try {
          return fn(selector === ".board-stage" ? [stage] : [], arg);
        } finally {
          Object.assign(globalThis, saved);
        }
      },
    }),
  };
  const lib = { observe, readState, stateSpec: { sections: [], defaults: [], read: null }, durable: null, stableObservation };
  const read = () => readWatched(page, { observe: [".board-stage"] }, lib);
  return { stage, read };
}

test("the diff lists changed paths with before and after, bounded", () => {
  const diff = diffValues(
    { url: "/", state: { note: { text: "a", revision: 1 }, list: [1, 2] } },
    { url: "/", state: { note: { text: "b", revision: 2 }, list: [1, 2, 3] } },
    limits,
  );
  assert.deepEqual(diff.changed, [
    { path: "state.list.2", before: undefined, after: "3" },
    { path: "state.note.revision", before: "1", after: "2" },
    { path: "state.note.text", before: '"a"', after: '"b"' },
  ]);
  assert.equal(diff.unchangedCount, 3);
  assert.deepEqual(diff.compared, { url: 1, state: 5 });
  const many = diffValues({ list: Array.from({ length: 60 }, () => 0) }, { list: Array.from({ length: 60 }, () => 1) }, limits);
  assert.equal(many.changed.length, 50);
  assert.equal(many.changedCount, 60);
  assert.equal(many.truncated, true);
  const long = diffValues({ text: "x" }, { text: "y".repeat(500) }, limits);
  assert.ok(long.changed[0].after.length <= 201);
});

test("observations keep what a person sees, on screen or not, but not focus or raw geometry", () => {
  const stable = stableObservation({
    count: 1,
    viewport: { width: 375, height: 629 },
    elements: [
      {
        text: "Saved",
        visible: true,
        inViewport: true,
        outsideViewport: { left: false, top: true, right: false, bottom: false },
        box: { x: 0.4, y: -12.6, width: 80.2, height: 20.1 },
        focused: true,
        scroll: { left: 0.4, top: 239.6, width: 80, height: 900, clientWidth: 80, clientHeight: 20 },
        clippedBy: [
          { tag: "div", id: null, x: false, y: true },
          { tag: "main", id: "workspace", x: true, y: true },
        ],
        attributes: {},
        css: {},
      },
    ],
  });
  assert.deepEqual(stable, {
    count: 1,
    elements: [
      {
        text: "Saved",
        visible: true,
        inViewport: true,
        outsideViewport: { left: false, top: true, right: false, bottom: false },
        clippedBy: "div:y main#workspace:xy",
        scroll: { left: 0, top: 240 },
        attributes: {},
        css: {},
      },
    ],
  });
});

test("an element scrolled from off screen into view is a change; one that stayed put is not", async () => {
  const { stage, read } = phone();
  const before = await read();
  // "Show board" ran scrollIntoView on it: same element, same text, now on screen.
  stage.rect = rect(16, 111, 343, 375);
  const after = await read();
  const diff = diffValues(before.values, after.values, limits);
  assert.equal(checkExpectation("effect", "change", diff, before, after), null, JSON.stringify(diff));
  assert.deepEqual(
    diff.changed.map(({ path, before: then, after: now }) => [path.replace("observe .board-stage.elements.0.", ""), then, now]),
    [
      ["clippedBy", '"div:y"', '""'],
      ["inViewport", "false", "true"],
      ["outsideViewport.top", "true", "false"],
    ],
  );
  assert.match(checkExpectation("effect", "none", diff, before, after), /expected no change, but .*inViewport/);

  // Read again without touching it: nothing changed, and the failure says what was compared.
  const again = await read();
  const same = diffValues(after.values, again.values, limits);
  assert.equal(same.changedCount, 0);
  assert.equal(checkExpectation("effect", "none", same, after, again), null);
  assert.deepEqual(same.compared, { url: 1, "observe .board-stage": 13 });
  assert.equal(same.unchangedCount, 14);
  assert.equal(
    checkExpectation("effect", "change", same, after, again),
    "effect: no watched change (14 values compared: url ×1, observe .board-stage ×13). An observed element " +
      "is compared by text, visible, inViewport, outsideViewport, clippedBy, scroll offsets, attributes " +
      "and css, not by position, size or focus.",
  );
});

test("sub-pixel and in-view moves are not changes; the element's own scrolling is", async () => {
  const { stage, read } = phone();
  stage.rect = rect(16, 111, 343, 375);
  const before = await read();
  // Layout jitter, and a banner above pushing it 40 px down while it stays on screen.
  stage.rect = rect(16.3, 151.4, 343.2, 374.9);
  const moved = await read();
  assert.equal(diffValues(before.values, moved.values, limits).changedCount, 0);
  // Scrolling the element itself changes what it shows; a sub-pixel scroll offset does not.
  stage.scrollTop = 0.4;
  const nudged = await read();
  assert.equal(diffValues(moved.values, nudged.values, limits).changedCount, 0);
  stage.scrollTop = 240;
  const scrolled = await read();
  const diff = diffValues(nudged.values, scrolled.values, limits);
  assert.deepEqual(diff.changed, [{ path: "observe .board-stage.elements.0.scroll.top", before: "0", after: "240" }]);
});

test("expectations catch the quiet no-op, an unwanted change, and a wrong value", () => {
  const same = diffValues({ a: 1 }, { a: 1 }, limits);
  const moved = diffValues({ a: 1 }, { a: 2 }, limits);
  const before = { values: { a: 1 } };
  const after = { values: { a: 2 } };
  assert.equal(checkExpectation("save", "change", same, before, before), "save: no watched change (1 value compared: a ×1).");
  assert.equal(checkExpectation("save", "change", moved, before, after), null);
  assert.equal(checkExpectation("cancel", "none", same, before, before), null);
  assert.match(checkExpectation("cancel", "none", moved, before, after), /expected no change, but a changed/);
  assert.equal(checkExpectation("x", { a: 2 }, moved, before, after), null);
  assert.match(checkExpectation("x", { a: 3 }, moved, before, after), /x: a is 2 \(was 1\)/);
  assert.equal(checkExpectation("x", { a: (now, then) => now > then }, moved, before, after), null);
  assert.equal(checkExpectation("x", undefined, moved, before, after), null);
});

test("settling is timed from Node: a page whose own timers are frozen still settles", async () => {
  // A paused installed clock: page-side setTimeout and requestAnimationFrame never fire. Only
  // evaluate calls that return at once and a Node-side wait are available.
  let mutations = 0;
  const page = {
    context: () => ({}),
    url: () => "http://127.0.0.1:1/",
    evaluate: async (fn) => (String(fn).includes("new MutationObserver") ? 0 : mutations),
    waitForTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const started = Date.now();
  assert.equal(await settle(page, 0, 2000), true);
  assert.ok(Date.now() - started < 1000, "settled once 150 ms passed without a mutation");
  // A page that keeps mutating does not settle, and the wait is still bounded.
  const busy = { ...page, evaluate: async (fn) => (String(fn).includes("new MutationObserver") ? 0 : ++mutations) };
  const before = Date.now();
  assert.equal(await settle(busy, 0, 400), false);
  assert.ok(Date.now() - before < 1500);
  // A page that cannot be read is not quiet, and is not waited on.
  const closed = { ...page, evaluate: async () => { throw new Error("closed"); } };
  assert.equal(await settle(closed, 0, 5000), false);
});

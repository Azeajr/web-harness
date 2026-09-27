import assert from "node:assert/strict";
import test from "node:test";
import { checkExpectation, diffValues, settle, stableObservation } from "../src/effect.mjs";

const limits = { entries: 50, value: 200 };

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
  const many = diffValues({ list: Array.from({ length: 60 }, () => 0) }, { list: Array.from({ length: 60 }, () => 1) }, limits);
  assert.equal(many.changed.length, 50);
  assert.equal(many.changedCount, 60);
  assert.equal(many.truncated, true);
  const long = diffValues({ text: "x" }, { text: "y".repeat(500) }, limits);
  assert.ok(long.changed[0].after.length <= 201);
});

test("observations keep what a person sees, not focus or geometry", () => {
  const stable = stableObservation({
    count: 1,
    viewport: { width: 1, height: 1 },
    elements: [{ text: "Saved", visible: true, focused: true, box: { x: 1 }, scroll: {}, attributes: {}, css: {} }],
  });
  assert.deepEqual(stable, { count: 1, elements: [{ text: "Saved", visible: true, attributes: {}, css: {} }] });
});

test("expectations catch the quiet no-op, an unwanted change, and a wrong value", () => {
  const same = diffValues({ a: 1 }, { a: 1 }, limits);
  const moved = diffValues({ a: 1 }, { a: 2 }, limits);
  const before = { values: { a: 1 } };
  const after = { values: { a: 2 } };
  assert.match(checkExpectation("save", "change", same, before, before), /save: no watched change/);
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

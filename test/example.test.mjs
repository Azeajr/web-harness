import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The acceptance suite runs the example in the Playwright image matched to the example's version,
// and preflight refuses a missing image: CI pulls the image for web-harness's own version. The
// two must be the same release, or the suite fails before it tests anything.
test("the example pins the same Playwright as web-harness", async () => {
  const read = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  const [own, example] = await Promise.all([read("../package.json"), read("../examples/minimal/package.json")]);
  assert.equal(example.devDependencies.playwright, own.devDependencies.playwright);
});

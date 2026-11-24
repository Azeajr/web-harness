import assert from "node:assert/strict";
import test from "node:test";
import { bumpText, normalize } from "../scripts/release.mjs";

test("bump rewrites the package version and every web-harness pin, nothing else", () => {
  const before = [
    '  "version": "0.2.7",',
    "- uses: Azeajr/web-harness/.github/actions/setup@v0.2.7",
    "pnpm add -D github:Azeajr/web-harness#v0.2.7",
    "- uses: actions/checkout@v7",
    '"playwright": "1.63.0"',
  ].join("\n");
  const after = bumpText(before, "0.2.8");
  assert.match(after, /"version": "0\.2\.8"/);
  assert.match(after, /setup@v0\.2\.8/);
  assert.match(after, /web-harness#v0\.2\.8/);
  assert.match(after, /checkout@v7/);
  assert.match(after, /"1\.63\.0"/);
});

test("a version-only change normalizes away; any other edit does not", () => {
  const base = '"version": "0.2.7"\nuses: Azeajr/web-harness/.github/actions/setup@v0.2.7\nrun: pnpm test\n';
  assert.equal(normalize(base), normalize(bumpText(base, "0.2.8")));
  assert.notEqual(normalize(base), normalize(bumpText(base, "0.2.8").replace("pnpm test", "pnpm check")));
});

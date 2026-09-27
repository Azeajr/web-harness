import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeDrift, ownVersion, versionDrift, workflowReferences } from "../src/versions.mjs";

test("every pinned action or workflow reference is checked against the installed version", () => {
  const drift = workflowReferences(
    {
      "ci.yml": [
        "      - uses: Azeajr/web-harness/.github/actions/scope@v0.1.4",
        "      - uses: Azeajr/web-harness/.github/actions/verdict@v0.1.2",
        "    uses: Azeajr/web-harness/.github/workflows/extended.yml@v0.1.4",
        "      - uses: actions/checkout@v7",
      ].join("\n"),
    },
    "0.1.4",
  );
  assert.equal(drift.references.length, 3);
  assert.deepEqual(drift.mismatches, [{ file: "ci.yml", line: 2, version: "0.1.2", ok: false }]);
  assert.match(describeDrift(drift)[0], /ci\.yml:2 uses web-harness v0\.1\.2; the installed package is v0\.1\.4/);
});

test("a project without workflows has nothing to drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wh-versions-"));
  try {
    assert.deepEqual((await versionDrift(root)).references, []);
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(path.join(root, ".github/workflows/ci.yml"), `uses: Azeajr/web-harness/.github/actions/setup@v${ownVersion}\n`);
    const drift = await versionDrift(root);
    assert.equal(drift.references.length, 1);
    assert.deepEqual(drift.mismatches, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

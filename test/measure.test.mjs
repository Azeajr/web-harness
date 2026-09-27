import assert from "node:assert/strict";
import test from "node:test";
import { parseDockerMemory, parseVmHwm, summarize } from "../src/metrics.mjs";
import { mutationScore } from "../src/mutation-score.mjs";

test("memory samples parse from docker stats and /proc status", () => {
  assert.equal(parseDockerMemory("123.5MiB / 3GiB"), Math.round(123.5 * 1024 ** 2));
  assert.equal(parseDockerMemory("1.2GiB / 3GiB"), Math.round(1.2 * 1024 ** 3));
  assert.equal(parseDockerMemory("512kB / 1GB"), 512_000);
  assert.equal(parseDockerMemory("--"), null);
  assert.equal(parseVmHwm("Name:\tnode\nVmPeak:\t 900 kB\nVmHWM:\t  204800 kB\nVmRSS:\t 1 kB\n"), 204800);
  assert.equal(parseVmHwm("Name:\tzombie\n"), null);
});

test("bench summaries: median and nearest-rank p90", () => {
  assert.deepEqual(summarize([]), { n: 0, median: null, p90: null, min: null, max: null });
  assert.deepEqual(summarize([30, 10, 20]), { n: 3, median: 20, p90: 30, min: 10, max: 30 });
  assert.deepEqual(summarize([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { n: 10, median: 6, p90: 9, min: 1, max: 10 });
  assert.equal(summarize([10, 20]).median, 15);
});

test("the mutation score counts detected over detected and undetected, not errors", () => {
  const mutants = (status, n) => Array.from({ length: n }, () => ({ status }));
  const report = {
    files: {
      "a.ts": { mutants: [...mutants("Killed", 6), ...mutants("Survived", 2)] },
      "b.ts": { mutants: [...mutants("Timeout", 1), ...mutants("NoCoverage", 1), ...mutants("CompileError", 5), ...mutants("Ignored", 3)] },
    },
  };
  const result = mutationScore(report);
  assert.equal(result.score, 70);
  assert.equal(result.detected, 7);
  assert.equal(result.undetected, 3);
  assert.equal(result.counts.CompileError, 5);
  assert.equal(mutationScore({ files: {} }).score, null);
  assert.throws(() => mutationScore({}), /Stryker JSON report/);
});

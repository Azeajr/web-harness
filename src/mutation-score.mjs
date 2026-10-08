import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

export const usage = `Usage: web-harness mutation-score [REPORT.json] [--min N]
Print the mutation score of a Stryker JSON report (default reports/mutation/mutation.json):
killed and timed-out mutants over those plus survived and uncovered ones.
  --min N  Exit 1 below N percent (0 to 100)`;

// Reads a Stryker JSON report (the `json` reporter; reports/mutation/mutation.json by default) and
// prints the mutation score: detected (killed, timed out) over detected plus undetected (survived,
// no coverage). Mutants that did not compile or run, or were ignored, are counted but not scored.
// With --min, exits 1 below it — the extended workflow's threshold.

const DETECTED = ["Killed", "Timeout"];
const UNDETECTED = ["Survived", "NoCoverage"];

// Pure.
export function mutationScore(report) {
  if (!report || typeof report.files !== "object") throw new Error("Not a Stryker JSON report (no files).");
  const counts = {};
  for (const file of Object.values(report.files))
    for (const mutant of file.mutants ?? []) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  const detected = DETECTED.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const undetected = UNDETECTED.reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  const scored = detected + undetected;
  return { score: scored ? Math.round((detected / scored) * 10000) / 100 : null, detected, undetected, counts };
}

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { min: { type: "string" } },
    strict: true,
  });
  const file = positionals[0] ?? "reports/mutation/mutation.json";
  const text = await readFile(file, "utf8").catch(() => {
    throw new Error(`No mutation report at ${file}. Enable Stryker's "json" reporter.`);
  });
  const result = mutationScore(JSON.parse(text));
  const min = values.min === undefined ? null : Number(values.min);
  if (min !== null && !(min >= 0 && min <= 100)) throw new Error("--min must be 0 to 100.");
  console.log(
    `Mutation score ${result.score ?? "n/a"}% (${result.detected} detected, ${result.undetected} undetected; ${Object.entries(result.counts).map(([status, count]) => `${status} ${count}`).join(", ")})`,
  );
  if (min !== null && (result.score === null || result.score < min))
    throw new Error(`Mutation score ${result.score ?? "n/a"}% is below the threshold ${min}%.`);
}

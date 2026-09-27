import { appendFileSync } from "node:fs";

// Pure decision, exported for tests: returns { ok, rows } for a toJSON(needs) object.
export function decide(needs, code, required) {
  const rows = Object.entries(needs).map(([job, { result }]) => {
    let problem = null;
    if (result === "failure" || result === "cancelled") problem = result;
    else if (code === "true" && required.includes(job) && result !== "success")
      problem = `${result} but required for a code change`;
    else if (job === "scope" && result !== "success") problem = `scope ${result}`;
    return { job, result, problem };
  });
  for (const job of required)
    if (!(job in needs)) rows.push({ job, result: "absent", problem: "required job is not in needs" });
  return { ok: rows.every((row) => !row.problem), rows };
}

if (process.env.NEEDS) {
  const required = (process.env.REQUIRED ?? "").split(/\s+/).filter(Boolean);
  const { ok, rows } = decide(JSON.parse(process.env.NEEDS), process.env.CODE, required);
  const table = [
    `### Verdict: ${ok ? "pass" : "FAIL"} (code change: ${process.env.CODE})`,
    "",
    "| job | result | problem |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row.job} | ${row.result} | ${row.problem ?? ""} |`),
  ].join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table + "\n");
  if (!ok) process.exitCode = 1;
}

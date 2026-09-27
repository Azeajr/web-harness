// One outcome vocabulary for every report the harness writes (batch, effect, faults, smoke,
// scenarios, manifest attempts). A session's lifecycle (starting, ready, stopped…) is its `state`,
// never its status.
export const STATUS = Object.freeze({
  passed: "passed",
  failed: "failed",
  infrastructureFailed: "infrastructure_failed",
  notRun: "not_run",
  unsupported: "unsupported",
  flaky: "flaky",
});

// Decided by where a failure came from, not by its message: a transport or health failure of the
// harness is infrastructure; an assertion, a fault or a failed expectation is the app's.
export function outcome({ ok, infrastructure = false }) {
  if (infrastructure) return STATUS.infrastructureFailed;
  return ok ? STATUS.passed : STATUS.failed;
}

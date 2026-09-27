import { STATUS } from "./status.mjs";

// The session manifest (`.web-harness/<session>/session.json`, copied to each run's manifest.json)
// is a versioned contract: schemas/run-manifest.v3.json documents it, and this checks one without a
// schema library. Returns the problems found; an empty list is a valid manifest.

export const SCHEMA_VERSION = 3;
export const STATES = ["starting", "ready", "restarting", "resetting", "infrastructure-failed", "cleanup-failed", "stopped"];

// What an artifact is, from its file name, for the manifest's index.
export function artifactKind(name) {
  if (/^manifest\.json$|^session\.json$/.test(name)) return "manifest";
  if (/^events\.jsonl$/.test(name)) return "events";
  if (/^network\.jsonl$/.test(name)) return "network";
  if (/^console\.jsonl$/.test(name)) return "console";
  if (/^timeline\.jsonl$/.test(name)) return "timeline";
  if (/^faults\.json$/.test(name)) return "faults";
  if (/^state\.json$/.test(name)) return "state";
  if (/^storage\.json$/.test(name)) return "storage";
  if (/^index\.json$/.test(name)) return "index";
  if (/^report\.json$/.test(name)) return "report";
  if (/\.ya?ml$/.test(name)) return "aria";
  if (/^trace.*\.zip$/.test(name)) return "trace";
  if (/\.(png|jpe?g)$/.test(name)) return "screenshot";
  if (/\.m?js$/.test(name)) return "source";
  return "other";
}

export function validateManifest(manifest) {
  const problems = [];
  const expect = (condition, message) => {
    if (!condition) problems.push(message);
  };
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isString = (value) => typeof value === "string" && value.length > 0;
  if (!isObject(manifest)) return ["manifest is not an object"];
  expect(manifest.schemaVersion === SCHEMA_VERSION, `schemaVersion is ${manifest.schemaVersion}, not ${SCHEMA_VERSION}`);
  for (const key of ["project", "root", "session", "output", "runId", "runDir", "profileDir", "image", "imageId", "browser", "device", "workflow"])
    expect(isString(manifest[key]), `${key} must be a non-empty string`);
  expect(["dev", "production"].includes(manifest.target), "target must be dev or production");
  expect(STATES.includes(manifest.state), `state must be one of ${STATES.join(", ")}`);
  expect(isObject(manifest.driver) && isString(manifest.driver.playwright) && isString(manifest.driver.node), "driver needs playwright and node versions");
  expect(isObject(manifest.limits) && isString(manifest.limits.containerMemory), "limits must record the container bounds");
  expect(isObject(manifest.timings) && typeof manifest.timings.preflight === "number", "timings must record at least preflight");
  expect(isObject(manifest.seed) && /^[0-9a-f]{64}$/.test(manifest.seed.digest ?? ""), "seed.digest must be a sha256");
  expect(isObject(manifest.seed?.environment) && ["real", "fixed", "install"].includes(manifest.seed.environment.clock), "seed.environment must record the clock mode");
  if (manifest.source !== undefined)
    expect(
      isObject(manifest.source) && "commit" in manifest.source && "dirty" in manifest.source && "dirtyDigest" in manifest.source,
      "source must record commit, dirty and dirtyDigest",
    );
  if (manifest.environment !== undefined)
    expect(isObject(manifest.environment?.effective) && "timezoneId" in manifest.environment.effective, "environment.effective must be read back from the page");
  if (manifest.build) expect(/^[0-9a-f]{64}$/.test(manifest.build.digest ?? ""), "build.digest must be a sha256");
  expect(Array.isArray(manifest.attempts), "attempts must be an array");
  for (const [index, attempt] of (manifest.attempts ?? []).entries())
    expect(
      isString(attempt.batchId) && Object.values(STATUS).includes(attempt.status),
      `attempts[${index}] needs batchId and a status from the status vocabulary`,
    );
  for (const [index, artifact] of (manifest.artifacts ?? []).entries())
    expect(
      isString(artifact.path) && isString(artifact.kind) && typeof artifact.bytes === "number" && typeof artifact.truncated === "boolean",
      `artifacts[${index}] needs path, kind, bytes and truncated`,
    );
  if (manifest.cleanup)
    expect(Object.values(STATUS).includes(manifest.cleanup.status) && Array.isArray(manifest.cleanup.errors), "cleanup needs status and errors");
  if (manifest.hostEnvironment)
    expect(typeof manifest.hostEnvironment.isolated === "boolean", "hostEnvironment.isolated must be a boolean");
  return problems;
}

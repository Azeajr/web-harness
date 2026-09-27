import os from "node:os";
import path from "node:path";

// The owned server runs on the host, outside the browser container, so it does not inherit the
// developer's whole environment: exported credentials (GH_TOKEN, CLOUDFLARE_API_TOKEN, …) stay out
// of a dev server and its plugins, and HOME/XDG point into the session directory, so nothing the
// server writes under "home" lands in the real one. The browser side was already isolated
// (containers run with HOME=/tmp).

// Kept by name or prefix. Anything else must be named by the adapter's dev.env.
const PASSED = ["PATH", "LANG", "LANGUAGE", "TERM", "TZ", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "COREPACK_HOME", "SHELL", "USER", "LOGNAME", "TMPDIR"];
const PASSED_PREFIXES = ["LC_", "npm_config_", "PNPM_", "COREPACK_"];
export const SECRET = /TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY|AUTH/i;

const matches = (name, pattern) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;

// Pure, for tests. `allow` holds the adapter's dev.env entries: exact names, or prefixes ending in *.
// A secret-looking name passes only when named exactly — never through a prefix or a default.
export function serverEnvironment(env, { home, allow = [], realHome = os.homedir(), isolate = true }) {
  if (!isolate) return { env: { ...env }, isolated: false, passed: Object.keys(env).sort(), dropped: [] };
  const result = {};
  const passed = [];
  const dropped = [];
  for (const [name, value] of Object.entries(env)) {
    const exact = allow.includes(name);
    const allowed =
      exact ||
      ((PASSED.includes(name) ||
        PASSED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
        allow.some((pattern) => matches(name, pattern))) &&
        !SECRET.test(name));
    if (allowed) {
      result[name] = value;
      passed.push(name);
    } else dropped.push(name);
  }
  result.HOME = home;
  result.XDG_CONFIG_HOME = path.join(home, ".config");
  result.XDG_CACHE_HOME = path.join(home, ".cache");
  result.XDG_DATA_HOME = path.join(home, ".local/share");
  result.XDG_STATE_HOME = path.join(home, ".local/state");
  // Corepack keeps downloaded package managers under the real home; a fresh one per session would
  // download pnpm again (or fail offline).
  if (!result.COREPACK_HOME) result.COREPACK_HOME = path.join(realHome, ".cache/node/corepack");
  return { env: result, isolated: true, passed: passed.sort(), dropped: dropped.sort() };
}

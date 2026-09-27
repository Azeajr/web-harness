import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { TRACE_MODES, slug } from "./core.mjs";
import { DEFAULT_REDACT_QUERY } from "./evidence.mjs";
import { faultPolicy } from "./faults.mjs";

export const CONFIG_FILE = "harness.config.mjs";

// The project root is the nearest ancestor holding harness.config.mjs, resolved through symlinks
// so ownership checks compare like with like.
export async function findRoot(start = process.cwd()) {
  let directory = path.resolve(start);
  for (;;) {
    try {
      await access(path.join(directory, CONFIG_FILE));
      return realpath(directory);
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory)
        throw new Error(`No ${CONFIG_FILE} in ${start} or any parent directory.`);
      directory = parent;
    }
  }
}

// Adapter functions that run inside the browser tooling are shipped as source text, so they may
// not close over anything. Method shorthand (`async ready(page) {}`) is not an expression on its
// own; rewrite it to a function expression rather than making every adapter avoid it.
export function functionSource(fn, label) {
  if (typeof fn !== "function") throw new Error(`${label} must be a function.`);
  const source = fn.toString();
  const compiles = (text) => {
    try {
      new Script(`(${text})`);
      return true;
    } catch {
      return false;
    }
  };
  if (compiles(source)) return source;
  const method = /^(async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (method) {
    const rewritten = `${method[1] ?? ""}function ${source.slice(method[1]?.length ?? 0)}`;
    if (compiles(rewritten)) return rewritten;
  }
  throw new Error(`${label} is not a standalone function expression.`);
}

const argv = (value, label) => {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string"))
    throw new Error(`${label} must return a non-empty array of strings.`);
  return value;
};

export function validateConfig(raw, root) {
  if (!raw || typeof raw !== "object") throw new Error(`${CONFIG_FILE} must export an object.`);
  const config = { ...raw };
  config.name = slug(raw.name, "name");
  config.root = root;
  config.port = raw.port ?? 4173;
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
    throw new Error("port must be an integer from 1024 to 65535.");
  config.playwrightFrom = path.resolve(root, raw.playwrightFrom ?? ".");
  config.defaults = { browser: "chromium", device: "Desktop Chrome", ...raw.defaults };
  if (typeof raw.dev?.command !== "function") throw new Error("dev.command(port) is required.");
  argv(raw.dev.command(config.port), "dev.command(port)");
  config.dev = { cwd: ".", marker: "/@vite/client", env: [], home: "isolated", ...raw.dev };
  if (!Array.isArray(config.dev.env) || config.dev.env.some((name) => typeof name !== "string"))
    throw new Error("dev.env must be an array of variable names (a trailing * matches a prefix).");
  if (!["isolated", "real"].includes(config.dev.home)) throw new Error('dev.home must be "isolated" or "real".');
  if (raw.production) {
    if (typeof raw.production.build !== "function")
      throw new Error("production.build(outDir) is required when production is configured.");
    argv(raw.production.build("/tmp/out"), "production.build(outDir)");
    config.production = { cwd: ".", ...raw.production };
  }
  config.fixtures = raw.fixtures ?? { blank: {} };
  for (const [name, fixture] of Object.entries(config.fixtures)) {
    slug(name, "fixture name");
    if (fixture.apply) functionSource(fixture.apply, `fixtures.${name}.apply`);
    if (fixture.prepare && typeof fixture.prepare !== "function")
      throw new Error(`fixtures.${name}.prepare must be a function.`);
  }
  config.defaultFixture = raw.defaultFixture ?? Object.keys(config.fixtures)[0];
  if (!config.fixtures[config.defaultFixture])
    throw new Error(`defaultFixture ${config.defaultFixture} is not registered.`);
  config.options = raw.options ?? [];
  if (raw.ready) functionSource(raw.ready, "ready");
  if (raw.initScript) functionSource(raw.initScript, "initScript");
  config.state = { sections: [], defaults: [], ...raw.state };
  if (config.state.read) functionSource(config.state.read, "state.read");
  if (config.state.defaults.some((section) => !config.state.sections.includes(section)))
    throw new Error("state.defaults must be registered sections.");
  config.policy = faultPolicy(raw.faults);
  config.evidence = evidenceConfig(raw.evidence);
  config.environment = environmentConfig(raw.environment);
  if (raw.durable !== undefined) {
    if (typeof raw.durable?.read !== "function") throw new Error("durable.read(page) must be a function.");
    functionSource(raw.durable.read, "durable.read");
  }
  config.scenarios = raw.scenarios ?? [];
  return config;
}

export async function loadConfig(start) {
  const root = await findRoot(start);
  const module = await import(pathToFileURL(path.join(root, CONFIG_FILE)).href);
  const config = validateConfig(module.default, root);
  if (!config.packageManager) {
    const has = (file) =>
      access(path.join(root, file)).then(
        () => true,
        () => false,
      );
    config.packageManager = (await has("pnpm-lock.yaml"))
      ? "pnpm"
      : (await has("package-lock.json"))
        ? "npm"
        : null;
    if (!config.packageManager)
      throw new Error("No pnpm-lock.yaml or package-lock.json; set packageManager in the config.");
  }
  return config;
}

// What failure evidence keeps, and what it never keeps. Query values whose names match a redaction
// pattern are replaced before a URL reaches any record, ring, bundle or timeline.
export function evidenceConfig(raw = {}) {
  const trace = raw.trace ?? "off";
  if (!TRACE_MODES.includes(trace)) throw new Error(`evidence.trace must be ${TRACE_MODES.join(", ")}.`);
  const query = raw.redact?.query ?? [];
  if (!Array.isArray(query)) throw new Error("evidence.redact.query must be an array.");
  const sources = query.map((pattern) => {
    const text = pattern instanceof RegExp ? pattern.source : pattern;
    if (typeof text !== "string" || !text) throw new Error("evidence.redact.query patterns must be strings.");
    new RegExp(text);
    return text;
  });
  if (raw.uploadTraces !== undefined && typeof raw.uploadTraces !== "boolean")
    throw new Error("evidence.uploadTraces must be a boolean.");
  return {
    trace,
    redactQuery: [...DEFAULT_REDACT_QUERY, ...sources],
    requestCap: raw.requestCap ?? 2000,
    consoleCap: raw.consoleCap ?? 1000,
    // Traces carry request and response bodies and headers. CI uploads them only when this is set.
    uploadTraces: raw.uploadTraces ?? false,
  };
}

export const CLOCK_MODES = ["real", "fixed", "install"];

// The environment a session's browser (and a suite, through harnessPlaywright) runs in. Command
// options (--timezone, --locale, --now, --clock) override it per session.
export function environmentConfig(raw = {}, overrides = {}) {
  const merged = { clock: "real", ...raw, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) };
  if (!CLOCK_MODES.includes(merged.clock)) throw new Error(`environment.clock must be ${CLOCK_MODES.join(", ")}.`);
  if (merged.clock !== "real") {
    if (!merged.now || Number.isNaN(Date.parse(merged.now)))
      throw new Error(`environment.clock "${merged.clock}" needs environment.now as an ISO date.`);
  }
  if (merged.timezoneId !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: merged.timezoneId });
    } catch {
      throw new Error(`Unknown timezone ${merged.timezoneId}.`);
    }
  }
  if (merged.locale !== undefined) {
    try {
      new Intl.Locale(merged.locale);
    } catch {
      throw new Error(`Invalid locale ${merged.locale}.`);
    }
  }
  return {
    timezoneId: merged.timezoneId ?? null,
    locale: merged.locale ?? null,
    clock: merged.clock,
    now: merged.clock === "real" ? null : new Date(merged.now).toISOString(),
  };
}

// Identity helper for editor types in harness.config.mjs: `export default defineHarness({...})`.
export const defineHarness = (config) => config;

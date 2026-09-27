import type { Page } from "playwright";

export type FaultKind =
  | "pageerror"
  | "console.error"
  | "console.warning"
  | "crash"
  | "requestfailed"
  | "http"
  | "external"
  | "infrastructure"
  | "layout-overflow";

export interface FaultConfig {
  /** Project-wide excuses for page/console noise. Regex sources or flagless RegExps. */
  allowed?: (string | RegExp)[];
  /** console.warning messages that mean a subsystem degraded without throwing. */
  watchedWarnings?: (string | RegExp)[];
  /** "fault": stub external calls and fail on them (default). "stub": stub silently. */
  external?: "fault" | "stub";
  /** Same-origin responses at or above this status are faults (default 400). */
  httpErrorStatus?: number;
  /** Same-origin path prefixes the static host does not serve (Pages Functions). */
  unservedPrefixes?: string[];
}

export interface EvidenceConfig {
  /** Default trace for `run` batches: off (default), retain-on-failure, or keep. */
  trace?: "off" | "retain-on-failure" | "keep";
  redact?: {
    /** Query parameter names (regex sources) whose values never reach evidence. Added to the defaults. */
    query?: (string | RegExp)[];
  };
  /** Ring sizes for every request and console line kept on a browser context. */
  requestCap?: number;
  consoleCap?: number;
  /** Traces carry request/response bodies and headers: upload them from CI only when true. */
  uploadTraces?: boolean;
}

export interface Fixture {
  description?: string;
  /**
   * Node side, before the browser: read files, validate, return JSON-serializable data. A `file`
   * property becomes the content of the `dataFile` handed to `apply` (e.g. a backup to import).
   */
  prepare?: (context: {
    root: string;
    options: Record<string, string>;
    resolve: (repoPath: string) => Promise<string>;
  }) => unknown | Promise<unknown>;
  /**
   * Browser-tooling side, SERIALIZED: may not close over anything. Drive the real UI.
   * `dataFile` is a path to the prepared data as JSON, for file inputs (run-code has no Buffer).
   */
  apply?: (page: Page, data: unknown, context: { dataFile: string | null }) => Promise<unknown>;
}

export interface Scenario {
  id: string;
  title: string;
  /** A Playwright test by file and exact title, or a required CI lane (e.g. "smoke"). */
  covers?: ({ file: string; test: string } | { lane: string })[];
  status?: "unsupported" | "not-run";
  reason?: string;
}

export interface HarnessConfig {
  /** Slug naming containers, sessions and locks. */
  name: string;
  /** Default port for agent sessions. */
  port?: number;
  /** Directory whose package.json resolves Playwright (default: the project root). */
  playwrightFrom?: string;
  packageManager?: "pnpm" | "npm";
  defaults?: { browser?: "chromium" | "firefox" | "webkit"; device?: string };
  dev: {
    /** argv for a dev server bound to 127.0.0.1:port with --strictPort. */
    command: (port: number) => string[];
    cwd?: string;
    /** Text only a dev server's HTML contains (the module entry path). */
    marker?: string;
    /**
     * Extra environment variables the dev server may see (exact names, or prefixes ending in *).
     * Everything else outside a small tool allowlist is withheld; secret-looking names pass only
     * when named exactly.
     */
    env?: string[];
    /** "isolated" (default): HOME and XDG dirs live in the session. "real": the developer's. */
    home?: "isolated" | "real";
  };
  production?: {
    /** argv that builds the production bundle into outDir. */
    build: (outDir: string) => string[];
    cwd?: string;
  };
  /** SERIALIZED: wait until the app is interactive. */
  ready?: (page: Page) => Promise<void>;
  /** SERIALIZED, runs in the page before any script: e.g. disable a network feature. */
  initScript?: () => void;
  fixtures?: Record<string, Fixture>;
  defaultFixture?: string;
  /** Extra --name VALUE options passed to fixture.prepare. */
  options?: string[];
  state?: {
    sections: string[];
    defaults: string[];
    /** SERIALIZED, runs IN THE PAGE via page.evaluate: read-only development accessor. */
    read?: (sections: string[]) => unknown;
  };
  /**
   * SERIALIZED, runs Node-side with the page (production-safe, read-only): the app's own durable
   * state, e.g. a record read from IndexedDB. `effect` reads it before and after an action.
   */
  durable?: { read: (page: Page) => Promise<unknown> };
  faults?: FaultConfig;
  evidence?: EvidenceConfig;
  /** Browser environment for sessions and harnessPlaywright; start --timezone/--locale/--clock/--now override it. */
  environment?: {
    timezoneId?: string;
    locale?: string;
    /** real (default); fixed: Date frozen at `now`, timers run; install: fully controlled clock. */
    clock?: "real" | "fixed" | "install";
    now?: string;
  };
  smoke?: {
    dist?: string;
    /**
     * Header names required on /, or per path (a trailing * checks the first built file under
     * it) with optional value patterns: { "/sw.js": [{ name: "cache-control", match: "no-cache" }] }.
     */
    requiredHeaders?: string[] | Record<string, (string | { name: string; match?: string | RegExp })[]>;
    devGlobals?: string[];
    serviceWorker?: boolean;
    offline?: boolean;
    allowedFaults?: (string | RegExp)[];
    /** Node side (closures fine). */
    ready?: (page: Page) => Promise<void>;
    persist?: (page: Page) => Promise<unknown>;
    verify?: (page: Page, token: unknown) => Promise<void>;
    /** Node side: after coming back online, anything the app does on reconnect. */
    reconnect?: (page: Page) => Promise<void>;
    /**
     * The update phase (false skips it). The second version is the build with only its service
     * worker script's bytes changed, unless `build(outDir)` makes a real one.
     */
    update?:
      | false
      | {
          sw?: string;
          mode?: "prompt" | "auto";
          /** Resolves once the app's update prompt is visible. */
          prompt?: (page: Page) => Promise<unknown>;
          /** Accepts it (e.g. clicks Reload). */
          accept?: (page: Page) => Promise<unknown>;
          /** Optional: dismisses it; the prompt must return after a reload. */
          dismiss?: (page: Page) => Promise<unknown>;
          build?: (outDir: string) => Promise<void>;
        };
  };
  e2e?: {
    config?: string;
    install?: string;
    prepare?: string[];
    snapshots?: string[];
    report?: string;
  };
  mutate?: { install?: string[]; command?: string[]; reports?: string[] };
  scenarios?: Scenario[];
}

export declare function defineHarness(config: HarnessConfig): HarnessConfig;

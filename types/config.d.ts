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
  smoke?: {
    dist?: string;
    requiredHeaders?: string[];
    devGlobals?: string[];
    serviceWorker?: boolean;
    offline?: boolean;
    allowedFaults?: (string | RegExp)[];
    /** Node side (closures fine). */
    ready?: (page: Page) => Promise<void>;
    persist?: (page: Page) => Promise<unknown>;
    verify?: (page: Page, token: unknown) => Promise<void>;
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

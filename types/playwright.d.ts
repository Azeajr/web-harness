import type { BrowserContext, Page, PlaywrightTestConfig, TestType } from "playwright/test";
import type { FaultKind, HarnessConfig } from "./config.js";

export interface FaultRecord {
  kind: FaultKind;
  detail: string;
}

export interface PageFaultGuard {
  watch(context: BrowserContext): Promise<void>;
  allow(patterns: (RegExp | string)[]): void;
  expect(kind: FaultKind | null, pattern: RegExp | string): void;
  add(records: FaultRecord[]): void;
  records(): FaultRecord[];
  faults(): FaultRecord[];
}

export interface A11yOptions {
  /** Violations at or above this impact are faults; lower ones are warnings. Default "serious". */
  impact?: "minor" | "moderate" | "serious" | "critical";
  /** Rules whose findings are kept but excused (excusedBy "a11y.disable"). */
  disable?: string[];
  include?: string[];
  exclude?: string[];
}

export interface A11yRecord {
  kind: "a11y" | "a11y-warning";
  detail: string;
  rule: string;
  impact: string;
  count: number;
  targets: string[];
  helpUrl: string;
  excusedBy?: "a11y.disable";
}

export interface A11yScan {
  faults: A11yRecord[];
  warnings: A11yRecord[];
  settings: Required<A11yOptions>;
  /** Automated rules find a subset of problems; a clean scan is not an audit. */
  boundary: string;
}

export interface HarnessFixtures {
  pageFaultGuard: PageFaultGuard;
  /** Wire a context the test built itself (browser.newContext()). */
  watchContext: (context: BrowserContext) => Promise<void>;
  /** Excuse faults this test causes on purpose — any kind, this test only. */
  allowPageFaults: (...patterns: (RegExp | string)[]) => void;
  /** Excuse AND require a fault: the failure path must actually fire. */
  expectPageFault: (kind: FaultKind | null, pattern: RegExp | string) => void;
  /** Scan the test's page with axe-core (harness.a11y); faults are judged at the end of the test. */
  checkA11y: (options?: A11yOptions) => Promise<A11yScan>;
}

/** A failing test also gets network.jsonl and console.jsonl attached. */
export declare function createHarnessTest<T extends object, W extends object>(
  base: TestType<T, W>,
  harness?: Pick<HarnessConfig, "faults" | "initScript" | "evidence" | "a11y">,
): TestType<T & HarnessFixtures, W>;

/** An axe-core scan of the page as it is now (needs axe-core in the project). */
export declare function scanA11y(page: Page, harness?: Pick<HarnessConfig, "a11y">, options?: A11yOptions & { root?: string }): Promise<A11yScan>;

/** Seed a test the way a session is seeded: fixture.prepare in Node, then apply through the page. */
export declare function applyHarnessFixture(
  page: Page,
  harness: HarnessConfig,
  name?: string,
  options?: { url?: string; options?: Record<string, string>; root?: string },
): Promise<{ url: string; viewport: { width: number; height: number; dpr: number }; applied: unknown }>;

export interface HarnessClock {
  mode: "real" | "fixed" | "install";
  runFor(ms: number | string): Promise<void>;
  fastForward(ms: number | string): Promise<void>;
  pauseAt(time: string | number | Date): Promise<void>;
  resume(): Promise<void>;
  setFixedTime(time: string | number | Date): Promise<void>;
  now(): Promise<number>;
}

export interface EffectWatch {
  observe?: string[];
  state?: string[];
  durable?: boolean;
  attributes?: string[];
  url?: false;
  settle?: (page: Page) => Promise<unknown>;
  screenshot?: boolean;
  expect?: "change" | "none" | Record<string, unknown | ((now: unknown, then: unknown) => boolean)>;
}

/** What a batch receives — in a session (`web-harness run`) or a promoted test (batchHelpers). */
export interface BatchHelpers {
  step<T>(name: string, action: () => T | Promise<T>): Promise<T>;
  assert(condition: unknown, message?: string): void;
  observe(selector: string, options?: { limit?: number; textLimit?: number; css?: string[]; attributes?: string[] }): Promise<any>;
  state(sections?: string[]): Promise<any>;
  effect<T>(name: string, action: () => T | Promise<T>, watch?: EffectWatch): Promise<T>;
  allowFault(pattern: RegExp | string): void;
  expectFault(kind: FaultKind | null, pattern: RegExp | string): void;
  clock: HarnessClock;
}

export type HarnessBatch = (page: Page, helpers: BatchHelpers) => Promise<unknown>;

export declare function batchHelpers(
  page: Page,
  harness: HarnessConfig,
  options?: {
    test?: { step<T>(name: string, body: () => T | Promise<T>): Promise<T> };
    expect?: (value: unknown, message?: string) => { toBeTruthy(): void };
    allowPageFaults?: (...patterns: (RegExp | string)[]) => void;
    expectPageFault?: (kind: FaultKind | null, pattern: RegExp | string) => void;
    target?: "dev" | "production";
  },
): BatchHelpers & { effects: unknown[] };

/**
 * Shared config fields: forbidOnly and one retry in CI, failOnFlakyTests in CI, and the trace,
 * screenshot and video of a failing attempt. Spread into defineConfig; `overrides.use` merges.
 */
export declare function harnessPlaywright(
  harness?: Partial<HarnessConfig>,
  overrides?: PlaywrightTestConfig,
): PlaywrightTestConfig;

export interface WebServer {
  command: string;
  url: string;
  reuseExistingServer: false;
  timeout: number;
}

export declare function productionServer(options: {
  port: number;
  /** Shell command that builds into `dist`, e.g. "pnpm build". Skipped when WEB_HARNESS_PREBUILT=1. */
  build: string;
  dist?: string;
  unserved?: string[];
  timeout?: number;
}): WebServer;

export declare function devServer(options: {
  command: string;
  port: number;
  timeout?: number;
}): WebServer;

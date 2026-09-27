import type { BrowserContext, TestType } from "playwright/test";
import type { FaultKind, HarnessConfig } from "./config.js";

export interface FaultRecord {
  kind: FaultKind;
  detail: string;
}

export interface PageFaultGuard {
  watch(context: BrowserContext): Promise<void>;
  allow(patterns: (RegExp | string)[]): void;
  expect(kind: FaultKind | null, pattern: RegExp | string): void;
  records(): FaultRecord[];
  faults(): FaultRecord[];
}

export interface HarnessFixtures {
  pageFaultGuard: PageFaultGuard;
  /** Wire a context the test built itself (browser.newContext()). */
  watchContext: (context: BrowserContext) => Promise<void>;
  /** Excuse faults this test causes on purpose — any kind, this test only. */
  allowPageFaults: (...patterns: (RegExp | string)[]) => void;
  /** Excuse AND require a fault: the failure path must actually fire. */
  expectPageFault: (kind: FaultKind | null, pattern: RegExp | string) => void;
}

export declare function createHarnessTest<T extends object, W extends object>(
  base: TestType<T, W>,
  harness?: Pick<HarnessConfig, "faults" | "initScript">,
): TestType<T & HarnessFixtures, W>;

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

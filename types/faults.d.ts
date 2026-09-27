import type { FaultConfig, FaultKind } from "./config.js";

export interface FaultPolicy {
  allowed: string[];
  watchedWarnings: string[];
  external: "fault" | "stub";
  httpErrorStatus: number;
  unservedPrefixes: string[];
}

export declare const DEFAULT_ALLOWED: string[];
export declare const EXCUSABLE_KINDS: FaultKind[];
export declare function faultPolicy(config?: FaultConfig): FaultPolicy;
export declare function failures<R extends { kind: string; detail: string }>(
  records: R[],
  policy: FaultPolicy,
  local?: (string | RegExp)[],
): R[];

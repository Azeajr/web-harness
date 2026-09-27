import type { Plugin } from "vite";

/** Serve-only dev-server identity for the agent harness. Inert in production builds. */
export declare function webHarness(): Plugin;

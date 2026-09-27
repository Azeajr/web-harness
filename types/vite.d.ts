/**
 * Serve-only dev-server identity for the agent harness. Inert in production builds.
 *
 * Typed structurally rather than as `import("vite").Plugin`: the plugin never imports Vite, and a
 * declared Vite type would resolve to whichever Vite sits beside this package — a different major
 * from the project's makes the plugins array fail to typecheck. This shape fits every major.
 */
export declare function webHarness(): { name: string; apply: "serve" };

import { createHarnessTest } from "@azeajr/web-harness/playwright";
import { test as base, expect } from "playwright/test";
import harness from "../../harness.config.mjs";

export const test = createHarnessTest(base, harness);
export { expect };

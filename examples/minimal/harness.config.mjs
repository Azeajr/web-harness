// Adapter for the example app. Functions marked SERIALIZED are shipped as source text into the
// browser tooling: they may not close over anything in this file.
import { defineHarness } from "@azeajr/web-harness/config";

// SERIALIZED. main.js marks the body once the saved note has rendered.
const ready = async (page) => {
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 15_000 });
};

export default defineHarness({
  name: "example",
  port: 4191,
  defaults: { browser: "chromium", device: "Desktop Chrome" },
  dev: {
    command: (port) => ["npx", "--no-install", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    marker: "/src/main.js",
  },
  production: {
    build: (outDir) => ["npx", "--no-install", "vite", "build", "--outDir", outDir, "--emptyOutDir"],
  },
  ready,
  fixtures: {
    saved: {
      description: "One note saved through the form",
      prepare: () => ({ text: "first note" }),
      // SERIALIZED
      async apply(page, data) {
        await page.getByRole("textbox", { name: "Note" }).fill(data.text);
        await page.getByRole("button", { name: "Save" }).click();
        await page.locator("#saved").filter({ hasText: data.text }).waitFor();
        return { saved: data.text };
      },
    },
    imported: {
      description: "A note restored through the import file input",
      prepare: () => ({ file: { note: "imported note" } }),
      // SERIALIZED
      async apply(page, _data, { dataFile }) {
        await page.locator("#import").setInputFiles(dataFile);
        await page.locator("#saved").filter({ hasText: "imported note" }).waitFor();
        return { imported: true };
      },
    },
    blank: { description: "Nothing saved" },
  },
  state: {
    sections: ["note", "sw"],
    defaults: ["note", "sw"],
    // SERIALIZED, runs in the page.
    read: async (sections) => {
      for (let i = 0; i < 50 && !window.__harness; i++) await new Promise((r) => setTimeout(r, 100));
      if (!window.__harness) throw new Error("Development state accessor unavailable.");
      return window.__harness.snapshot(sections);
    },
  },
  faults: { unservedPrefixes: ["/api/"] },
  smoke: {
    requiredHeaders: ["content-security-policy", "x-content-type-options"],
    ready,
    persist: async (page) => {
      await page.getByRole("textbox", { name: "Note" }).fill("smoke note");
      await page.getByRole("button", { name: "Save" }).click();
      await page.locator("#saved").filter({ hasText: "smoke note" }).waitFor();
      return "smoke note";
    },
    verify: async (page, text) => {
      await page.locator("#saved").filter({ hasText: text }).waitFor({ timeout: 10_000 });
    },
  },
  e2e: { config: "playwright.config.js", snapshots: [] },
  scenarios: [
    {
      id: "save-note",
      title: "Save a note and still see it after a reload",
      covers: [{ file: "tests/e2e/notes.spec.js", test: "saves a note that survives a reload" }],
    },
    {
      id: "offline-install",
      title: "The shipped build installs and reloads offline",
      covers: [{ lane: "smoke" }],
    },
    {
      id: "installed-phone",
      title: "Installed to a phone's home screen",
      status: "unsupported",
      reason: "The harness runs emulated browsers only.",
    },
  ],
});

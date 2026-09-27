import { webHarness } from "@azeajr/web-harness/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    webHarness(),
    VitePWA({
      // Every consumer app waits for the user before a new version takes over.
      registerType: "prompt",
      injectRegister: false,
      manifest: false,
      workbox: { globPatterns: ["**/*.{js,css,html}"], cleanupOutdatedCaches: true },
    }),
  ],
});

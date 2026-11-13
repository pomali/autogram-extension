import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test as base, chromium, type BrowserContext } from "@playwright/test";

const DIST_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../dist"
);

/**
 * Playwright test with the built extension (dist/) loaded into a Chromium
 * persistent context — the only way Chromium loads extensions. Build it
 * first: `npm run vite:build-e2e` (MV3 is the default).
 */
export const test = base.extend<{ context: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    if (!fs.existsSync(path.join(DIST_PATH, "manifest.json"))) {
      throw new Error(
        `extension build not found at ${DIST_PATH} — run \`npm run vite:build-e2e\` first`
      );
    }
    // Chromium ignores the HTTPS_PROXY environment variable; pass it on
    // explicitly so the live-portal tests also run behind a corporate/CI
    // proxy. Loopback stays direct (the fake Autogram desktop app).
    const proxyServer = process.env.HTTPS_PROXY ?? process.env.https_proxy;
    const context = await chromium.launchPersistentContext("", {
      // Extensions require the real Chromium; the default headless shell
      // does not support them.
      channel: "chromium",
      // Optional override for a Chromium that Playwright did not download
      // itself (a system or sandbox-provided build).
      executablePath: process.env.AE_E2E_CHROMIUM_PATH || undefined,
      proxy: proxyServer
        ? { server: proxyServer, bypass: "localhost,127.0.0.1" }
        : undefined,
      args: [
        `--disable-extensions-except=${DIST_PATH}`,
        `--load-extension=${DIST_PATH}`,
      ],
    });
    await use(context);
    await context.close();
  },
  page: async ({ context }, use) => {
    // reuse the tab the persistent context opens on launch
    await use(context.pages()[0] ?? (await context.newPage()));
  },
});

export const expect = test.expect;

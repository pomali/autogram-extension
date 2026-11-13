/**
 * The schranka.slovensko.sk harness: a small document served at a URL on
 * the portal's real origin that loads the portal's live signing stack
 * (D.Bridge + DSignerMulti.js) from the production servers. See
 * schranka-live-driver.spec.ts for why and what it does (not) cover.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "./extension.fixtures";
import { expectDitecReplaced } from "./portal-driver";

export const HARNESS_URL =
  "https://schranka.slovensko.sk/__autogram-e2e__/harness";
const DBRIDGE_BASE = "https://www.slovensko.sk/static/zep/dbridge_js/v1.0";
const DRIVER_URL =
  "https://schranka.slovensko.sk/Content/jscript/DSignerMulti.js?v=20250601";

/**
 * The page shell DSignerMulti.js expects from schranka's eDesk UI, reduced
 * to recording stubs (same surface as testing/load-dsigner-multi.ts).
 */
const HARNESS_HTML = `<!doctype html>
<html lang="sk">
  <head>
    <meta charset="utf-8" />
    <title>Autogram extension e2e harness</title>
    <script>
      window.__e2eShell = { errors: [], modals: [], alerts: [] };
      window.eDesk = {
        core: {
          modalShow: function (id) { __e2eShell.modals.push("show:" + id); },
          modalClose: function (id) { __e2eShell.modals.push("close:" + id); },
          compareVersions: function (a, b) {
            var as = a.split(".").map(Number), bs = b.split(".").map(Number);
            for (var i = 0; i < Math.max(as.length, bs.length); i++) {
              var diff = (as[i] || 0) - (bs[i] || 0);
              if (diff !== 0) return diff < 0 ? -1 : 1;
            }
            return 0;
          },
        },
      };
      window.MessageBox = {
        displayError: function (message) { __e2eShell.errors.push(message); },
      };
      window.$ = {
        grep: function (arr, fn) { return arr.filter(fn); },
      };
      window.alert = function (message) { __e2eShell.alerts.push(String(message)); };
    </script>
    <script src="${DBRIDGE_BASE}/config.js"></script>
    <script src="${DBRIDGE_BASE}/dCommon.min.js"></script>
    <script src="${DBRIDGE_BASE}/dSigXades.min.js"></script>
    <script src="${DBRIDGE_BASE}/dSigXadesBp.min.js"></script>
    <script src="${DRIVER_URL}"></script>
  </head>
  <body>
    <h1>Autogram extension e2e harness</h1>
  </body>
</html>`;

export interface Shell {
  errors: string[];
  modals: string[];
  alerts: string[];
}

/**
 * Navigates `page` to the harness and waits until the extension owns
 * `window.ditec`. Only the harness document is synthetic; every script it
 * references is fetched from the production servers.
 */
export async function openSchrankaHarness(context: BrowserContext, page: Page) {
  await context.route(HARNESS_URL, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: HARNESS_HTML,
    })
  );
  await page.goto(HARNESS_URL);

  // precondition: the portal's own stack really loaded — otherwise the
  // "replace-original" strategy has nothing to replace and the test would
  // not be exercising the live scripts at all
  expect(
    await page.evaluate(() => {
      const w = window as { DSigner?: unknown; ditec?: object };
      return { driver: typeof w.DSigner, ditec: typeof w.ditec };
    })
  ).toEqual({ driver: "function", ditec: "object" });

  await expectDitecReplaced(page);
}

/** What the portal's page shell (error dialog, alerts) recorded. */
export const readShell = (page: Page) =>
  page.evaluate(() => (window as unknown as { __e2eShell: Shell }).__e2eShell);

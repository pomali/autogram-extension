/**
 * Semi-live e2e for schranka.slovensko.sk, which is entirely behind the
 * slovensko.sk login — there is no anonymous page that loads its signer.
 *
 * Instead of logging in, the test serves a small harness document at a URL
 * on the portal's real origin (Playwright intercepts only that one
 * navigation). The harness loads the portal's *live* signing stack from the
 * production servers, in the order the real pages do:
 *
 *   www.slovensko.sk/static/zep/dbridge_js/v1.0/*.js   (D.Bridge)
 *   schranka.slovensko.sk/Content/jscript/DSignerMulti.js (the driver)
 *
 * Because the document lives on https://schranka.slovensko.sk, the browser
 * treats it like any other schranka page: the manifest's content script
 * match, the site's injection strategy (wait for `load`) and its conflict
 * resolution (replace an existing `window.ditec`) all run for real, against
 * whatever D.Bridge + driver build the portal serves today. That makes
 * this both an injection test and a behavioural drift check — the
 * checksum-based `npm run test:portal-drift` only says *that* a script
 * changed, this says whether signing still works after it did.
 *
 * Not real: the page shell (eDesk/MessageBox are recording stubs, as in
 * portal-schranka.test.ts), the Autogram desktop app (local fake) and the
 * document. Nothing is submitted to the portal.
 */
import { test, expect } from "./extension.fixtures";
import {
  startFakeAutogramDesktop,
  type FakeAutogramDesktop,
} from "./fake-autogram-desktop";
import {
  asicRequest,
  chooseDesktopSigning,
  expectDitecReplaced,
  readSignOutcome,
  startPortalSign,
  xdcDocument,
  XDC_MIME,
  XDC_XMLNS_V1_1,
} from "./portal-driver";

const HARNESS_URL = "https://schranka.slovensko.sk/__autogram-e2e__/harness";
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

interface Shell {
  errors: string[];
  modals: string[];
  alerts: string[];
}

let desktop: FakeAutogramDesktop;

test.beforeAll(async () => {
  desktop = await startFakeAutogramDesktop();
});

test.afterAll(async () => {
  await desktop?.close();
});

test.beforeEach(async ({ context, page }) => {
  desktop.mode = "sign";
  desktop.signRequests.length = 0;
  // only the harness document is synthetic; every script it references is
  // fetched from the production servers
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
      return {
        driver: typeof w.DSigner,
        ditec: typeof w.ditec,
      };
    })
  ).toEqual({ driver: "function", ditec: "object" });

  await expectDitecReplaced(page);
});

const readShell = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __e2eShell: Shell }).__e2eShell);

test("live schranka driver signs an XML data container (ASiC) through the extension", async ({
  page,
}) => {
  const document = xdcDocument();
  await startPortalSign(page, asicRequest([document]));
  await chooseDesktopSigning(page);

  await expect
    .poll(async () => (await readSignOutcome(page)).results.length)
    .toBe(1);
  const outcome = await readSignOutcome(page);
  expect(outcome.errors).toEqual([]);
  expect(outcome.results[0]).toBe(desktop.signedContent);

  // no portal error dialog (this is where the "install the newest
  // D.Signer" getVersion gate would surface) and no alert() fallback
  const shell = await readShell(page);
  expect(shell.errors).toEqual([]);
  expect(shell.alerts).toEqual([]);

  expect(desktop.signRequests).toHaveLength(1);
  expect(desktop.signRequests[0]).toMatchObject({
    document: { content: document.Data },
    payloadMimeType: `${XDC_MIME};base64`,
    parameters: {
      level: "XAdES_BASELINE_B",
      container: "ASiC_E",
      containerXmlns: XDC_XMLNS_V1_1,
      identifier: document.Uri,
    },
  });
});

test("live schranka driver gets a visible error for a multi-document signature", async ({
  page,
}) => {
  // schranka signs a message together with its attachments in one
  // signature; the extension cannot yet, and must say so through the
  // portal's own error dialog instead of signing only one of them
  await startPortalSign(
    page,
    asicRequest([xdcDocument("form-object"), xdcDocument("attachment-1")])
  );

  await expect.poll(async () => (await readShell(page)).errors.length).toBe(1);
  expect((await readShell(page)).errors[0]).toContain("viacerých");
  expect((await readSignOutcome(page)).results).toEqual([]);
  // nothing reached the signer
  expect(desktop.signRequests).toEqual([]);
});

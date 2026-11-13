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
import { openSchrankaHarness, readShell } from "./schranka-harness";
import {
  asicRequest,
  chooseDesktopSigning,
  readSignOutcome,
  startPortalSign,
  xdcDocument,
  XDC_MIME,
  XDC_XMLNS_V1_1,
} from "./portal-driver";

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
  await openSchrankaHarness(context, page);
});

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

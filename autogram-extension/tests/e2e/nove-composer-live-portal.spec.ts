/**
 * Live-portal e2e for the nove.slovensko.sk message composer
 * (https://message-constructor-web.slovensko.sk).
 *
 * The composer itself is behind the slovensko.sk login, but its app shell
 * is not: an anonymous visit lands on its `/error` route, which still
 * loads everything signing needs — the production D.Bridge scripts
 * (www.slovensko.sk/static/zep/dbridge_js) and the composer's own driver
 * (dSigner/scripts/DSignerMulti.js). So without logging in we can run the
 * full production path on the real page:
 *
 *   content script → inject bundle → window.ditec replacement
 *     → the portal's live DSigner.sign() choreography
 *     → extension signing dialog → background worker RPC → desktop app
 *
 * Only two things are not real: the Autogram desktop app (a local fake on
 * port 37200) and the document (a canned XML data container — the portal
 * never sees the result, the test reads it from the driver's callback).
 *
 * This is the layer above portal-nove.test.ts, which replays a downloaded
 * copy of the same driver against a fake implementation in jsdom.
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

const PORTAL_URL = "https://message-constructor-web.slovensko.sk/";

let desktop: FakeAutogramDesktop;

test.beforeAll(async () => {
  desktop = await startFakeAutogramDesktop();
});

test.afterAll(async () => {
  await desktop?.close();
});

test.beforeEach(async ({ page }) => {
  desktop.mode = "sign";
  desktop.signRequests.length = 0;
  await page.goto(PORTAL_URL);
  // the page's own driver, not something the test brings along
  await page.waitForFunction(
    () => typeof (window as { DSigner?: unknown }).DSigner === "function"
  );
  await expectDitecReplaced(page);
});

test("pins the composer's signing method to D.Signer (our window.ditec)", async ({
  page,
}) => {
  // fixed-signer.ts: the composer's own "Autogram" method bypasses
  // window.ditec, so the content script pins the method before it boots
  expect(
    await page.evaluate(() => window.localStorage.getItem("signer-type"))
  ).toBe("Dsigner");
});

test("the portal's live DSigner signs an XML data container through the extension", async ({
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
  // the driver hands the portal exactly what the desktop app returned
  expect(outcome.results[0]).toBe(desktop.signedContent);

  // what the live driver's choreography made the desktop app sign
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

test("cancelling in the desktop app ends the portal's flow without a result", async ({
  page,
}) => {
  desktop.mode = "cancel";
  await startPortalSign(page, asicRequest([xdcDocument()]));
  await chooseDesktopSigning(page);

  // the desktop app answered (204 = cancelled)…
  await expect.poll(() => desktop.signRequests.length).toBe(1);
  // …and the driver swallows the resulting DitecError code 1: no result,
  // no uncaught error (the composer's build throws on any other code)
  await page.waitForTimeout(1_500);
  const outcome = await readSignOutcome(page);
  expect(outcome.results).toEqual([]);
  expect(outcome.errors).toEqual([]);

  // a cancelled attempt must not block the next one
  desktop.mode = "sign";
  await startPortalSign(page, asicRequest([xdcDocument()]));
  await chooseDesktopSigning(page);
  await expect
    .poll(async () => (await readSignOutcome(page)).results)
    .toEqual([desktop.signedContent]);
});

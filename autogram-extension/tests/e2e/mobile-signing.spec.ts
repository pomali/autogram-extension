/**
 * Mobile signing (Autogram v mobile) end to end in a real browser: the
 * live schranka.slovensko.sk signing stack (see schranka-harness.ts) on
 * one side, a local fake of the AVM server on the other
 * (fake-avm-server.ts), and in between everything the extension does for
 * the mobile path — the QR screen, the background worker's upload and
 * polling, restore points, the pairing frame.
 *
 * "The user signs on the phone" is `avm.signDocument(guid)`; "a phone
 * scans the pairing QR code" is `avm.pairDevice(integrationGuid)`.
 *
 * Needs the e2e build of the extension (`npm run vite:build-e2e`, which
 * `npm run test:e2e` runs first): it is the only build that talks to the
 * fake instead of the production AVM server.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./extension.fixtures";
import {
  FAKE_AVM_BASE_URL,
  startFakeAvmServer,
  type FakeAvmServer,
} from "./fake-avm-server";
import { openSchrankaHarness, readShell } from "./schranka-harness";
import {
  asicRequest,
  chooseMobileSigning,
  readSignOutcome,
  startPortalSign,
  xdcDocument,
  XDC_MIME,
} from "./portal-driver";

let avm: FakeAvmServer;

test.beforeAll(async () => {
  // Safety net: with any other build these tests would upload their
  // documents to (and register integrations on) the production server.
  const background = fs.readFileSync(
    path.resolve(process.cwd(), "dist/autogram-background.bundle.js"),
    "utf-8"
  );
  if (!background.includes(FAKE_AVM_BASE_URL)) {
    throw new Error(
      "dist/ was not built for e2e — run `npm run vite:build-e2e` (or " +
        "`npm run test:e2e`) so the extension uses the fake AVM server"
    );
  }
  avm = await startFakeAvmServer();
});

test.afterAll(async () => {
  await avm?.close();
});

test.beforeEach(async ({ context, page }) => {
  avm.reset();
  await openSchrankaHarness(context, page);
});

/** The signing dialog's QR screen; resolves the document it is for. */
async function waitForSigningQr(page: Page) {
  const qrLink = page.getByRole("link", { name: "QR kód na podpísanie" });
  await expect(qrLink).toBeVisible();
  const signingUrl = new URL((await qrLink.getAttribute("href"))!);
  // the QR code leads the phone to the (fake) AVM server
  expect(signingUrl.href.startsWith(`${FAKE_AVM_BASE_URL}/qr-code?`)).toBe(
    true
  );
  const guid = signingUrl.searchParams.get("guid")!;
  return { guid, key: signingUrl.searchParams.get("key")! };
}

async function startMobileSigning(page: Page, request: unknown) {
  await startPortalSign(page, request);
  await chooseMobileSigning(page);
  return waitForSigningQr(page);
}

const portalResults = async (page: Page) =>
  (await readSignOutcome(page)).results;

test("signs on the phone: upload, QR code, signature delivered to the portal", async ({
  page,
}) => {
  const document = xdcDocument();
  const { guid, key } = await startMobileSigning(page, asicRequest([document]));

  // what the portal's live driver made the extension upload
  expect(avm.documents).toHaveLength(1);
  expect(avm.documents[0]).toMatchObject({
    guid,
    encryptionKey: key,
    request: {
      document: { content: document.Data },
      payloadMimeType: `${XDC_MIME};base64`,
      parameters: { container: "ASiC-E", identifier: document.Uri },
    },
  });
  // nothing is delivered before the phone signs
  await expect.poll(() => avm.documents[0].polls).toBeGreaterThan(1);
  expect(await portalResults(page)).toEqual([]);

  avm.signDocument(guid);

  await expect.poll(() => portalResults(page)).toEqual([avm.signedContent]);
  expect((await readSignOutcome(page)).errors).toEqual([]);
  expect((await readShell(page)).errors).toEqual([]);
});

test("closing the QR screen cancels: polling stops and a later phone signature is not delivered", async ({
  page,
}) => {
  const { guid } = await startMobileSigning(page, asicRequest([xdcDocument()]));
  await expect.poll(() => avm.documents[0].polls).toBeGreaterThan(0);

  await page.getByRole("button", { name: /Zavrieť|Close/ }).click();
  await expect(
    page.getByRole("link", { name: "QR kód na podpísanie" })
  ).toBeHidden();

  // the background worker stops asking the server about the document
  await page.waitForTimeout(1_500);
  const pollsAfterClose = avm.documents[0].polls;
  await page.waitForTimeout(2_500);
  expect(avm.documents[0].polls).toBe(pollsAfterClose);

  // signing on the phone now is too late — nothing reaches the portal
  avm.signDocument(guid);
  await page.waitForTimeout(2_000);
  expect(await portalResults(page)).toEqual([]);

  // and the cancelled attempt does not get in the way of the next one
  const second = await startMobileSigning(page, asicRequest([xdcDocument()]));
  expect(second.guid).not.toBe(guid);
  avm.signDocument(second.guid);
  await expect.poll(() => portalResults(page)).toEqual([avm.signedContent]);
});

for (const how of ["drop", "error"] as const) {
  test(`a server outage while waiting (${how}) does not lose the signature`, async ({
    page,
  }) => {
    const { guid } = await startMobileSigning(
      page,
      asicRequest([xdcDocument()])
    );
    await expect.poll(() => avm.documents[0].polls).toBeGreaterThan(0);

    avm.failNextPolls(3, how);
    avm.signDocument(guid);

    // retried with backoff (2 s, 4 s, 8 s) → allow for it
    await expect
      .poll(() => portalResults(page), { timeout: 30_000 })
      .toEqual([avm.signedContent]);
    // the dialog never fell over to an error screen on the way
    expect((await readShell(page)).errors).toEqual([]);
  });
}

test("a document the server no longer has ends the wait with an error in the portal", async ({
  page,
}) => {
  const { guid } = await startMobileSigning(page, asicRequest([xdcDocument()]));
  avm.expireDocument(guid);

  await expect
    .poll(async () => (await readShell(page)).errors.length, {
      timeout: 20_000,
    })
    .toBe(1);
  expect(await portalResults(page)).toEqual([]);
  // the dialog shows the reason instead of a QR code nobody can use
  await expect(page.getByText("už nie je dostupný")).toBeVisible();
});

test.describe("restore points", () => {
  test("a signature made while the page was reloading is offered and restored", async ({
    context,
    page,
  }) => {
    const request = asicRequest([xdcDocument()]);
    const { guid } = await startMobileSigning(page, request);

    // the user switches to the phone; the browser drops the page meanwhile
    await openSchrankaHarness(context, page);
    avm.signDocument(guid);

    // back on the portal, the same document is sent for signing again
    await startPortalSign(page, request);
    await page.getByRole("button", { name: /Áno, obnoviť podpis/ }).click();

    await expect.poll(() => portalResults(page)).toEqual([avm.signedContent]);
    // restored, not signed a second time
    expect(avm.documents).toHaveLength(1);
  });

  test("declining the restored signature starts a fresh signing", async ({
    context,
    page,
  }) => {
    const request = asicRequest([xdcDocument()]);
    const { guid } = await startMobileSigning(page, request);
    await openSchrankaHarness(context, page);
    avm.signDocument(guid);

    await startPortalSign(page, request);
    await page.getByRole("button", { name: /Nie, začať odznova/ }).click();
    await chooseMobileSigning(page);
    const fresh = await waitForSigningQr(page);

    expect(fresh.guid).not.toBe(guid);
    expect(avm.documents).toHaveLength(2);
    expect(await portalResults(page)).toEqual([]);
  });

  test("a different document on the same page is never offered the old signature", async ({
    context,
    page,
  }) => {
    const { guid } = await startMobileSigning(
      page,
      asicRequest([xdcDocument("form-A")])
    );
    await openSchrankaHarness(context, page);
    avm.signDocument(guid);

    // document B: the method chooser comes up, not the restore prompt
    await startPortalSign(page, asicRequest([xdcDocument("form-B")]));
    await expect(
      page.getByRole("button", { name: /Podpísať v mobile/ })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Áno, obnoviť podpis/ })
    ).toBeHidden();
  });

  test("a signing cancelled in the page leaves nothing to restore", async ({
    context,
    page,
  }) => {
    const request = asicRequest([xdcDocument()]);
    const { guid } = await startMobileSigning(page, request);
    await page.getByRole("button", { name: /Zavrieť|Close/ }).click();
    // give the cancellation time to reach the background worker
    await page.waitForTimeout(1_500);

    // signed on the phone anyway, then the page is reloaded
    avm.signDocument(guid);
    await openSchrankaHarness(context, page);

    await startPortalSign(page, request);
    await expect(
      page.getByRole("button", { name: /Podpísať v mobile/ })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Áno, obnoviť podpis/ })
    ).toBeHidden();
  });
});

test.describe("phone pairing", () => {
  test("the pairing QR code is shown in an extension frame and pairing sends the request to the phone", async ({
    page,
  }) => {
    const { guid } = await startMobileSigning(
      page,
      asicRequest([xdcDocument()])
    );
    // signing by QR code needs no integration
    expect(avm.integrations).toEqual([]);

    await page.getByRole("link", { name: /Spárujte si tento počítač/ }).click();

    // the QR code lives in a frame of the extension's own origin…
    const frameElement = page.locator("iframe.qr-frame");
    await expect(frameElement).toBeVisible();
    expect(await frameElement.getAttribute("src")).toMatch(
      /^chrome-extension:\/\/[a-p]{32}\/static\/pairing\.html\?t=\d+$/
    );
    const frame = page.frameLocator("iframe.qr-frame");
    await expect(frame.locator("#qr svg")).toBeVisible();
    // …which registered the integration to get its pairing URL
    await expect.poll(() => avm.integrations.length).toBe(1);

    // the pairing token must not be anywhere a page script could read it
    const pageMarkup = await page.evaluate(() => {
      const collect = (root: Document | ShadowRoot): string =>
        Array.from(root.querySelectorAll("*"))
          .map(
            (el) => el.outerHTML + (el.shadowRoot ? collect(el.shadowRoot) : "")
          )
          .join("");
      return collect(document);
    });
    expect(pageMarkup).not.toContain("qr-code-register");
    expect(pageMarkup).not.toContain("integration=");

    // a phone scans the pairing code
    avm.pairDevice(avm.integrations[0], { displayName: "Pixel E2E" });

    await expect(page.getByText("Pixel E2E")).toBeVisible({ timeout: 15_000 });
    // …and gets the pending document pushed to it right away
    await expect
      .poll(() => avm.notifications)
      .toEqual([{ integrationGuid: avm.integrations[0], documentGuid: guid }]);

    avm.signDocument(guid);
    await expect.poll(() => portalResults(page)).toEqual([avm.signedContent]);
  });
});

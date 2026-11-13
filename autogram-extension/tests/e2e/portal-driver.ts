/**
 * Helpers for driving a portal's own `DSigner` (DSignerMulti.js — the
 * signing driver shared by schranka.slovensko.sk and the nove.slovensko.sk
 * message composer) from a Playwright test, the way the portal's page code
 * does. The request shapes mirror the jest contract tests
 * (src/dbridge_js/ditecx/portal-*.test.ts).
 */
import type { Page } from "@playwright/test";
import { expect } from "./extension.fixtures";

export const XDC_MIME = "application/vnd.gov.sk.xmldatacontainer+xml";
export const XDC_XMLNS_V1_1 =
  "http://data.gov.sk/def/container/xmldatacontainer+xml/1.1";

export const SAMPLE_XDC_XML = "<XMLDataContainer><XMLData/></XMLDataContainer>";

/** eDesk XDC document as the portals' backends build it. */
export function xdcDocument(objectId = "form-object") {
  return {
    IsXml: true,
    XmlFormId: XDC_MIME,
    ObjectId: objectId,
    Description: "Všeobecná agenda",
    Uri: "http://data.gov.sk/doc/eform/App.GeneralAgenda/1.9",
    Data: Buffer.from(SAMPLE_XDC_XML).toString("base64"),
    Xsd: "<xs:schema/>",
    Xslt: "<xsl:stylesheet/>",
  };
}

export function asicRequest(documents: unknown[]) {
  return {
    SignatureType: "ASiC",
    SignatureId: "Signature-1",
    Documents: documents,
  };
}

/** Page-side record of what the portal's `DSigner.sign` reported back. */
export interface PortalSignOutcome {
  /** Values passed to the result callback, in order. */
  results: unknown[];
  /** Uncaught errors/rejections raised while the driver ran. */
  errors: string[];
}

/**
 * The extension must own `window.ditec` before the portal's driver touches
 * it; when this fails the portal's real D.Bridge (→ D.Launcher) is in
 * charge and every later assertion would be misleading.
 */
export async function expectDitecReplaced(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as { ditec?: { isAutogram?: boolean } }).ditec
              ?.isAutogram === true
        ),
      {
        message:
          "window.ditec was not replaced by the extension — the portal's " +
          "own D.Bridge (→ D.Launcher) is driving the page",
        timeout: 20_000,
      }
    )
    .toBe(true);
}

/**
 * Starts `new DSigner().sign(request, cb)` in the page — the portal's own
 * driver class, loaded by the page itself — without waiting for it: the
 * extension's signing dialog has to be clicked through first. Read the
 * outcome with {@link readSignOutcome}.
 */
export async function startPortalSign(page: Page, request: unknown) {
  await page.evaluate((signRequest) => {
    const w = window as unknown as {
      DSigner: new () => {
        sign(request: unknown, cb: (result: unknown) => void): void;
      };
      __e2eSign: PortalSignOutcome;
    };
    const outcome: PortalSignOutcome = { results: [], errors: [] };
    w.__e2eSign = outcome;
    window.addEventListener("error", (event) =>
      outcome.errors.push(String(event.error ?? event.message))
    );
    window.addEventListener("unhandledrejection", (event) =>
      outcome.errors.push(String(event.reason))
    );
    new w.DSigner().sign(signRequest, (result) => outcome.results.push(result));
  }, request);
}

export function readSignOutcome(page: Page): Promise<PortalSignOutcome> {
  return page.evaluate(
    () => (window as unknown as { __e2eSign: PortalSignOutcome }).__e2eSign
  );
}

/** Picks "sign on this computer" in the extension's signing dialog. */
export async function chooseDesktopSigning(page: Page) {
  await page.getByRole("button", { name: /v tomto počítači/ }).click();
}

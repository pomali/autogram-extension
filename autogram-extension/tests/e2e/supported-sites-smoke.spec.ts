/**
 * Live smoke test over the public landing pages of supported portals:
 * the content script must match the page, get its inject bundle into the
 * page (portal CSP changes are the usual way this breaks), and leave a
 * page that has no D.Signer alone.
 *
 * It does not sign anything — see the per-portal specs for that — but it
 * is cheap, needs no login and covers portals whose signing pages we
 * cannot reach anonymously.
 */
import { test, expect } from "./extension.fixtures";

const PUBLIC_PAGES = [
  "https://www.slovensko.sk/sk/titulna-stranka",
  "https://www.financnasprava.sk/sk/titulna-stranka",
  "https://cep.financnasprava.sk/sk/titulna-stranka",
  "https://sluzby.orsr.sk/",
];

for (const url of PUBLIC_PAGES) {
  test(`extension injects cleanly on ${new URL(url).host}`, async ({
    page,
  }) => {
    const extensionFailures: string[] = [];
    page.on("requestfailed", (request) => {
      if (request.url().startsWith("chrome-extension://")) {
        extensionFailures.push(`request failed: ${request.url()}`);
      }
    });
    page.on("pageerror", (error) => {
      if (error.stack?.includes("chrome-extension://")) {
        extensionFailures.push(`page error: ${error.message}`);
      }
    });
    page.on("console", (message) => {
      // CSP violations are reported as console errors, not page errors
      if (
        message.type() === "error" &&
        message.text().includes("chrome-extension://")
      ) {
        extensionFailures.push(`console error: ${message.text()}`);
      }
    });

    await page.goto(url, { waitUntil: "load" });

    // these sites inject on window load; the tag appearing means the
    // content script matched the URL and ran
    await expect(
      page.locator('script[src*="autogram-inject.bundle.js"]')
    ).toHaveCount(1);
    // give the bundle time to evaluate (and to fail, if it is going to)
    await page.waitForTimeout(1_500);

    expect(extensionFailures).toEqual([]);
    // no D.Signer on a landing page → nothing to replace, nothing invented
    expect(await page.evaluate(() => "ditec" in window)).toBe(false);
  });
}

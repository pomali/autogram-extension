/**
 * The page ↔ extension bridge is reachable by every script on a supported
 * portal (it is a pair of CustomEvents on `window`), so what it exposes is
 * a security boundary. This pins the one thing that must never cross it:
 * the phone-pairing URL, whose token is enough to pair a phone that then
 * receives documents sent for signing from every portal.
 */
import { test, expect } from "./extension.fixtures";

const PORTAL_URL = "https://www.slovensko.sk/sk/titulna-stranka";

/** Calls a bridge method the way any page script could. */
function callBridge(
  page: import("@playwright/test").Page,
  service: string,
  method: string
) {
  return page.evaluate(
    ([service, method]) =>
      new Promise<{ ok: boolean; payload: unknown } | "no-response">(
        (resolve) => {
          const id = `e2e-${Math.random()}`;
          window.addEventListener(
            "autogram-message-response-content-script-to-injected",
            (event) => {
              const frame = (event as CustomEvent).detail;
              if (frame?.id === id) {
                resolve({ ok: frame.ok, payload: frame.payload });
              }
            }
          );
          window.dispatchEvent(
            new CustomEvent(
              "autogram-send-message-injected-to-content-script",
              { detail: { id, service, method, payload: null } }
            )
          );
          setTimeout(() => resolve("no-response"), 5_000);
        }
      ),
    [service, method]
  );
}

test("a page script cannot obtain the pairing URL over the bridge", async ({
  page,
}) => {
  await page.goto(PORTAL_URL);
  await expect(
    page.locator('script[src*="autogram-inject.bundle.js"]')
  ).toHaveCount(1);

  // control: the bridge itself answers page scripts (that is by design —
  // signing is confirmed in the desktop app or on the phone)
  const paired = await callBridge(page, "avm", "getPairedDevices");
  expect(paired).not.toBe("no-response");

  const pairing = await callBridge(page, "avm", "getPairingQrCodeUrl");
  expect(pairing).toMatchObject({ ok: false });
  expect(JSON.stringify(pairing)).not.toContain("qr-code-register");
});

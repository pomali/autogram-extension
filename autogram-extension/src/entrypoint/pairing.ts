/**
 * The pairing frame: an extension page that shows the QR code pairing a
 * phone (Autogram v mobile) with this extension.
 *
 * The signing dialog lives in the DOM of the government portal, and the
 * pairing URL carries a token that is all it takes to pair a phone — a
 * phone that then receives every document sent for signing from any
 * portal. Rendering the QR code in the portal's DOM would hand that token
 * to every script on the page. So the dialog embeds this page as a frame
 * instead: it has the extension's origin, the portal cannot read into it,
 * and it gets the pairing URL straight from the background worker, which
 * answers extension pages only.
 */
import browser from "webextension-polyfill";
import { toSVG as bwipToSvg } from "@bwip-js/generic";
import {
  PAIRING_URL_REQUEST,
  type PairingUrlResponse,
} from "../dbridge_js/autogram/background-worker-messages";

/** the pairing token lives 5 minutes */
const REFRESH_INTERVAL_MS = 4 * 60 * 1000;

async function showPairingQrCode() {
  const container = document.getElementById("qr");
  const status = document.getElementById("status");
  if (!container || !status) {
    return;
  }
  try {
    const response = (await browser.runtime.sendMessage({
      type: PAIRING_URL_REQUEST,
    })) as PairingUrlResponse | undefined;
    if (!response?.ok) {
      throw new Error("pairing URL not available");
    }
    container.innerHTML = bwipToSvg({
      bcid: "qrcode",
      text: response.pairingUrl,
      scale: 6,
      width: 100,
      height: 100,
    });
    status.textContent = "";
  } catch (error) {
    console.error("Autogram: failed to prepare the pairing QR code", error);
    container.innerHTML = "";
    status.textContent = "Párovací QR kód sa nepodarilo pripraviť.";
  }
}

void showPairingQrCode();
setInterval(() => void showPairingQrCode(), REFRESH_INTERVAL_MS);

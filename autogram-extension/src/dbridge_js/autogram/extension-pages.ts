/**
 * Where the injected script (which runs in the page and has no access to
 * `runtime.getURL`) finds the extension's own pages.
 */

let extensionBaseUrl: string | null = null;

/**
 * Remember the extension's base URL, derived from the URL the inject
 * bundle itself was loaded from. Call it synchronously while the bundle
 * evaluates — `document.currentScript` is gone afterwards.
 */
export function rememberExtensionBaseUrl(
  currentScript: HTMLOrSVGScriptElement | null
): void {
  const src = (currentScript as HTMLScriptElement | null)?.src;
  if (!src) {
    return;
  }
  try {
    const url = new URL(".", src);
    if (/^(chrome|moz|safari-web)-extension:$/.test(url.protocol)) {
      extensionBaseUrl = url.href;
    }
  } catch {
    // not a parseable URL — pairing is simply not offered from the page
  }
}

/**
 * URL of the extension page that shows the phone-pairing QR code, or
 * `null` when the base URL is unknown. The page is embedded as a frame in
 * the signing dialog; see entrypoint/pairing.ts for why it exists.
 */
export function pairingFrameUrl(): string | null {
  return extensionBaseUrl ? `${extensionBaseUrl}static/pairing.html` : null;
}

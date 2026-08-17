let _extensionBaseUrl = "";

/**
 * Set the base URL of the browser extension (e.g. "chrome-extension://<id>/").
 * Must be called once from the inject entrypoint before the UI is mounted.
 */
export function setExtensionBaseUrl(url: string): void {
  _extensionBaseUrl = url;
}

/**
 * Returns the base URL of the browser extension that was previously set via
 * {@link setExtensionBaseUrl}, or an empty string if it has not been set.
 */
export function getExtensionBaseUrl(): string {
  return _extensionBaseUrl;
}

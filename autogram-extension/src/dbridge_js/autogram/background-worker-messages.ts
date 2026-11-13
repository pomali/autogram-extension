/**
 * One-off messages between extension pages and the background worker
 * (`runtime.sendMessage`) — separate from the page-callable RPC service in
 * channel/services.ts. Kept free of other imports so small extension pages
 * can use it without bundling the background worker.
 */

/** Asks for the URL that pairs a phone with the extension. */
export const PAIRING_URL_REQUEST = "autogram:get-pairing-url" as const;

export type PairingUrlResponse =
  | { ok: true; pairingUrl: string }
  | { ok: false };

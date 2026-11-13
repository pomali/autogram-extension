import { get, set } from "idb-keyval";
import { AVMDocumentToSign, AVMSignedDocument } from ".";
import {
  AutogramVMobileIntegrationInterfaceStateful,
  AutogramVMobileIntegration,
  AvmRegistrationInfo,
  DBInterface,
} from "./avm-api/lib/apiClient";
import {
  MobileClient,
  PairedDevice,
  RestorePointStore,
  SignatureRequest,
} from "./mobile";
import { createLogger } from "./log";
import { AutogramError } from "./errors";
import { SignedObject } from "./types";

const log = createLogger("ag-sdk:AvmSimpleChannel");

const WAIT_FOR_SIGNATURE_TIMEOUT_MS = 1000 * 60 * 60 * 2; // 2 hours

export interface AvmSimpleChannelOptions {
  /**
   * Send a push notification to paired devices when a document is added.
   * Default `true`.
   */
  notifyDevices?: boolean;
  /**
   * Where the integration identity (key pair + integration GUID) and
   * restore points are persisted. Pairings are bound to this identity, so
   * the storage must survive page reloads for paired phones to keep
   * receiving notifications. Default: IndexedDB of the current origin
   * (`idb-keyval`).
   */
  storage?: DBInterface;
}

/**
 * Default direct implementation of {@link AutogramVMobileIntegrationInterfaceStateful}
 * that communicates with the Autogram v Mobile (AVM) cloud service.
 *
 * Thin stateful adapter over {@link MobileClient}: it tracks "the current
 * signature request" between the interface's step-wise calls
 * (`addDocument` → `getQrCodeUrl` → `waitForSignature` → `reset`).
 *
 * {@link useRestorePoint} provides cross-page-reload continuity via
 * {@link RestorePointStore}: the request token is persisted in the
 * configured storage (IndexedDB by default) so an in-progress signing
 * session can be recovered after navigation.
 *
 * This class is the default channel used by `CombinedClient`. The
 * browser extension replaces it with `AvmChannelWeb`, which routes
 * calls through the content-script ↔ injected-script message bridge
 * instead of talking to the AVM API directly.
 */
export class AvmSimpleChannel implements AutogramVMobileIntegrationInterfaceStateful {
  private client: MobileClient;
  private restorePoints: RestorePointStore;

  private request: SignatureRequest | null = null;
  private abortController: AbortController | null = null;
  /**
   * Restore point looked up for the signing in progress; bound to the
   * request once its document is uploaded, forgotten on {@link reset}.
   */
  private restorePoint: string | null = null;

  constructor(private options: AvmSimpleChannelOptions = {}) {
    const storage = options.storage ?? { get, set };
    this.client = new MobileClient(new AutogramVMobileIntegration(storage));
    this.restorePoints = new RestorePointStore(
      storage,
      this.client,
      "restorePoint:"
    );
  }

  async init(regInfo: AvmRegistrationInfo): Promise<void> {
    // integration is registered on demand, only pairing needs it
    await this.client.init(regInfo);
  }
  async getQrCodeUrl(): Promise<string> {
    return this.currentRequest().qrCodeUrl();
  }
  async getPairingQrCodeUrl(): Promise<string> {
    return this.client.pairingQrCodeUrl();
  }
  async addDocument(documentToSign: AVMDocumentToSign): Promise<void> {
    this.request = await this.client.requestSignature(documentToSign, {
      notifyDevices: this.options.notifyDevices ?? true,
    });
    if (this.restorePoint) {
      await this.restorePoints.save(this.restorePoint, this.request.token);
    }
  }
  async sendNotification(): Promise<void> {
    await this.currentRequest().notifyDevices();
  }
  getPairedDevices(): Promise<PairedDevice[]> {
    return this.client.pairedDevices();
  }
  async waitForSignature(
    externalAbortController?: AbortController
  ): Promise<AVMSignedDocument> {
    const request = this.currentRequest();
    // TODO abort when tab is closed
    const abortController = new AbortController();
    this.abortController = abortController;

    // the caller's controller (the dialog's close button) must stop the
    // polling — otherwise a "cancelled" request keeps running and can
    // still resolve later, on top of the next signing
    const externalSignal = externalAbortController?.signal;
    const onExternalAbort = () => abortController.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      onExternalAbort();
    } else {
      externalSignal?.addEventListener("abort", onExternalAbort, {
        once: true,
      });
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort("Timeout");
    }, WAIT_FOR_SIGNATURE_TIMEOUT_MS);

    try {
      const res = await request.waitForSignature({
        signal: abortController.signal,
      });
      log.debug("res", res);
      return res;
    } catch (e) {
      if (timedOut) {
        throw new AutogramError(
          "timeout",
          "Časový limit na podpísanie v mobile vypršal",
          { cause: e }
        );
      }
      throw e;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  async abortWaitForSignature(): Promise<void> {
    this.abortController?.abort("Aborted");
  }
  async reset(): Promise<void> {
    // a wait still running belongs to the request being dropped
    this.abortController?.abort("Reset");
    this.request = null;
    this.abortController = null;
    // The signing finished or was cancelled while the page was alive, so
    // there is nothing to restore; only a page that went away mid-signing
    // (and never got to reset) leaves its restore point behind.
    const restorePoint = this.restorePoint;
    this.restorePoint = null;
    if (restorePoint) {
      await this.restorePoints.remove(restorePoint);
    }
  }

  async useRestorePoint(restorePoint: string): Promise<SignedObject | null> {
    const result = await this.restorePoints.use(restorePoint);
    if (result.outcome === "signed") {
      this.restorePoint = null;
      return result.signedObject;
    }
    // Not signed (yet): the upcoming addDocument() uploads the document
    // this restore point identifies and binds the two together. A pending
    // older upload is superseded by it — the user is asked to sign anew.
    this.restorePoint = restorePoint;
    return null;
  }

  private currentRequest(): SignatureRequest {
    if (!this.request) {
      throw new Error("Document not found");
    }
    return this.request;
  }
}

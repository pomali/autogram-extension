import {
  AutogramVMobileIntegrationInterfaceStateful,
  AVMDocumentToSign,
  AVMSignedDocument,
  PairedDevice,
  AutogramDesktopIntegrationInterface,
  DesktopLegacyAutogramDocument,
  DesktopLegacySignatureParameters,
  DesktopSignResponseBody,
  DesktopSignRequestBody,
  DesktopServerInfo,
  DesktopBatchStartResponseBody,
  DesktopBatchEndResponseBody,
  SignedObject,
  createRpcClient,
  RpcCallerFrame,
  RpcClient,
  RpcClientTransport,
  RpcResponseFrame,
  ZRpcResponseFrame,
} from "autogram-sdk";
import { avmService, autogramService } from "./services";
import {
  EVENT_MESSAGE_RESPONSE_CS_TO_INJ,
  EVENT_SEND_MESSAGE_INJ_TO_CS,
} from "./common";
import { createLogger } from "../../../log";

const log = createLogger("ag-ext.channel.web");

/**
 * Class used on side of injected content script
 */
export class AutogramDesktopChannel implements AutogramDesktopIntegrationInterface {
  private rpc: RpcClient<typeof autogramService.methods>;

  constructor(channel: WebChannelCaller) {
    this.rpc = createRpcClient(autogramService, channel);
  }

  getLaunchURL(command?: "listen"): Promise<string> {
    return this.rpc.getLaunchURL({ command });
  }
  info(): Promise<DesktopServerInfo> {
    return this.rpc.info(null);
  }
  waitForStatus(
    status: DesktopServerInfo["status"],
    timeout?: number,
    delay?: number,
    abortController?: AbortController
  ): Promise<DesktopServerInfo> {
    return this.rpc.waitForStatus(
      { status, timeout, delay },
      { signal: abortController?.signal }
    );
  }
  async signLegacy(
    document: DesktopLegacyAutogramDocument,
    signatureParameters?: DesktopLegacySignatureParameters,
    payloadMimeType?: string,
    batchId?: string,
    abortController?: AbortController
  ): Promise<DesktopSignResponseBody> {
    const response = await this.rpc.signLegacy(
      { document, signatureParameters, payloadMimeType, batchId },
      { signal: abortController?.signal }
    );
    log.debug("signLegacy response", response);
    return response;
  }
  async signV1(
    body: DesktopSignRequestBody,
    abortController?: AbortController
  ): Promise<DesktopSignResponseBody> {
    const response = await this.rpc.signV1(
      { body },
      { signal: abortController?.signal }
    );
    log.debug("signV1 response", response);
    return response;
  }
  startBatch(
    totalNumberOfDocuments: number,
    abortController?: AbortController
  ): Promise<DesktopBatchStartResponseBody> {
    return this.rpc.startBatch(
      { totalNumberOfDocuments },
      { signal: abortController?.signal }
    );
  }
  endBatch(
    batchId: string,
    abortController?: AbortController
  ): Promise<DesktopBatchEndResponseBody> {
    return this.rpc.endBatch({ batchId }, { signal: abortController?.signal });
  }
}

/**
 * Class used on side of injected content script
 */
export class AvmChannelWeb implements AutogramVMobileIntegrationInterfaceStateful {
  private rpc: RpcClient<typeof avmService.methods>;
  /**
   * Restore point looked up for the signing in progress. Kept here, in the
   * page, because that is exactly its lifetime: it is sent along with the
   * document it identifies (so the background binds the two) and with the
   * reset that ends the signing (so the background forgets it). A page
   * that goes away mid-signing never resets — its restore point stays.
   */
  private restorePoint: string | null = null;

  /**
   * @param pairingFrameUrl URL of the extension page that renders the
   * pairing QR code (see {@link getPairingQrCodeUrl}); without it pairing
   * is not offered from the page.
   */
  constructor(
    channel: WebChannelCaller,
    private pairingFrameUrl: string | null = null
  ) {
    this.rpc = createRpcClient(avmService, channel);
    if (!pairingFrameUrl) {
      // drop the notifications capability so the SDK never shows pairing UI
      this.getPairingQrCodeUrl = undefined;
    }
  }

  /* registration info is provided by the background worker itself */
  async init(): Promise<void> {
    await this.rpc.init(null);
  }
  getQrCodeUrl(): Promise<string> {
    return this.rpc.getQrCodeUrl(null);
  }
  /**
   * The pairing token must not reach the page (any of its scripts could
   * take it and pair a phone of their own), so this returns the URL of an
   * extension page instead; the SDK dialog embeds it as a frame the page
   * cannot read into. The frame asks the background worker for the real
   * pairing URL itself. A fresh query string makes the dialog reload the
   * frame — that is how the SDK's periodic refresh keeps the QR valid.
   */
  getPairingQrCodeUrl?: () => Promise<string> = async () =>
    `${this.pairingFrameUrl}?t=${Date.now()}`;

  async addDocument(documentToSign: AVMDocumentToSign): Promise<void> {
    await this.rpc.addDocument({
      documentToSign,
      restorePoint: this.restorePoint ?? undefined,
    });
  }
  async sendNotification(): Promise<void> {
    await this.rpc.sendNotification(null);
  }
  getPairedDevices(): Promise<PairedDevice[]> {
    return this.rpc.getPairedDevices(null);
  }
  waitForSignature(
    abortController?: AbortController
  ): Promise<AVMSignedDocument> {
    return this.rpc.waitForSignature(null, {
      signal: abortController?.signal,
    });
  }
  async reset(): Promise<void> {
    const restorePoint = this.restorePoint ?? undefined;
    this.restorePoint = null;
    await this.rpc.reset({ restorePoint });
  }
  async useRestorePoint(restorePoint: string): Promise<SignedObject | null> {
    log.debug("useRestorePoint", restorePoint);
    const restored = await this.rpc.useRestorePoint({ restorePoint });
    // not signed yet: the upcoming addDocument() is the document this
    // restore point stands for
    this.restorePoint = restored ? null : restorePoint;
    return restored;
  }
}

/**
 * Injected-script side of the bridge: an {@link RpcClientTransport} that
 * moves RPC frames over CustomEvents.
 *
 * injected script --(EVENT_SEND_MESSAGE_INJ_TO_CS)--> content script
 * injected script <--(EVENT_MESSAGE_RESPONSE_CS_TO_INJ)-- content script
 */
export class WebChannelCaller implements RpcClientTransport {
  private responseListeners: Array<(frame: RpcResponseFrame) => void> = [];

  private responseEventHandler = (evt: CustomEvent) => {
    log.debug("web message response ⬅️", evt.detail);
    const frame = ZRpcResponseFrame.parse(evt.detail);
    this.responseListeners.forEach((callback) => callback(frame));
  };

  public init() {
    window.addEventListener(
      EVENT_MESSAGE_RESPONSE_CS_TO_INJ,
      this.responseEventHandler
    );
  }

  public destroy() {
    window.removeEventListener(
      EVENT_MESSAGE_RESPONSE_CS_TO_INJ,
      this.responseEventHandler
    );
  }

  public send(frame: RpcCallerFrame): void {
    log.debug("Sending frame ➡️", frame);
    const evt = new CustomEvent(EVENT_SEND_MESSAGE_INJ_TO_CS, {
      detail: frame,
      bubbles: true,
      composed: true,
    });
    window.dispatchEvent(evt);
  }

  public onResponse(callback: (frame: RpcResponseFrame) => void): void {
    this.responseListeners.push(callback);
  }
}

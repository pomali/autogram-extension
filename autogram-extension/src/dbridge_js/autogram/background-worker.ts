import {
  desktopApiClient,
  AutogramVMobileIntegration,
  AutogramError,
  MobileClient,
  RestorePointStore,
  createRpcHandler,
  serializeRpcError,
  ZRpcCallerFrame,
} from "autogram-sdk";
import type {
  AVMDocumentToSign,
  AVMIntegrationDocument,
  DesktopSignRequestBody,
  RpcHandler,
  RpcImpl,
  RpcResponseFrame,
} from "autogram-sdk";
import type { SignedDocument } from "autogram-sdk/avm-api";
import { avmService, autogramService } from "./channel/services";
import { get, set } from "idb-keyval";
import browser from "webextension-polyfill";
import { createLogger } from "../../log";
import { getAvmIntegrationRegistrationInfo } from "../../util-extension";
import { getOptions } from "../../options/content";
import { supportedSites } from "../../supported-sites";
import { withConfiguredAvmServer } from "../../avm-server";
import {
  PAIRING_URL_REQUEST,
  type PairingUrlResponse,
} from "./background-worker-messages";

const log = createLogger("ag-ext.bg.worker");

export class BackgroundWorker {
  private handlers: RpcHandler[];

  constructor(
    private avm = new AvmExecutor(),
    private autogram = new AutogramExecutor()
  ) {
    this.handlers = [
      createRpcHandler(avmService, this.avm.impl),
      createRpcHandler(autogramService, this.autogram.impl),
    ];
  }

  initListener() {
    log.debug("initListener");
    browser.runtime.onConnect.addListener(this.onConnectListener.bind(this));
    browser.runtime.onMessage.addListener(
      this.onPairingUrlRequest.bind(this) as Parameters<
        typeof browser.runtime.onMessage.addListener
      >[0]
    );
  }

  /**
   * Answers the pairing frame (entrypoint/pairing.ts) and nobody else: the
   * request must come from a page of this extension. Content scripts —
   * the only part of the extension a web page can talk to — report the web
   * page's URL as their sender URL and are turned away.
   */
  onPairingUrlRequest(
    message: unknown,
    sender: browser.Runtime.MessageSender
  ): Promise<PairingUrlResponse> | undefined {
    if (!isPairingUrlRequest(message)) {
      return undefined; // not ours — let other listeners answer
    }
    if (!isExtensionPage(sender)) {
      log.warn("Pairing URL requested from outside the extension", sender.url);
      return Promise.resolve({ ok: false });
    }
    return this.avm.pairingQrCodeUrl().then(
      (pairingUrl) => ({ ok: true, pairingUrl }),
      (error) => {
        log.error("Preparing the pairing URL failed", error);
        return { ok: false };
      }
    );
  }

  onConnectListener(newPort: browser.Runtime.Port) {
    log.debug("onConnect", newPort);

    if (!isSupportedSiteContentScript(newPort.sender)) {
      // Defence in depth: the bridge is meant for our content scripts on
      // the supported portals only.
      log.warn("Rejected a connection from", newPort.sender?.url);
      newPort.disconnect();
      return;
    }

    const postFrame = (port: browser.Runtime.Port, frame: RpcResponseFrame) => {
      log.debug("background response", frame);
      try {
        port.postMessage(frame);
      } catch (e) {
        log.error("postMessage error", e);
      }
    };

    const handleMessage = (request: unknown, port: browser.Runtime.Port) => {
      const sender = port.sender;
      if (!sender) {
        throw new Error("Sender not found");
      }
      const senderId = getSenderId(sender);
      const frame = ZRpcCallerFrame.parse(request);
      log.debug("background frame", frame);

      if ("abort" in frame) {
        // Abort frames carry no service; every handler checks its own in-flight map.
        this.handlers.forEach(
          (handler) => void handler.handle(frame, senderId)
        );
        return;
      }

      // keepalive ping just starts the worker
      if (frame.method === "hello") {
        return;
      }

      const handler = this.handlers.find(
        (candidate) => candidate.serviceName === frame.service
      );
      if (!handler) {
        postFrame(port, {
          id: frame.id,
          ok: false,
          payload: serializeRpcError(
            new AutogramError(
              "protocol-error",
              `Unknown service ${frame.service}`
            )
          ),
        });
        return;
      }

      void handler.handle(frame, senderId).then((response) => {
        if (response) {
          postFrame(port, response);
        }
      });
    };

    if (newPort.sender) {
      this.avm
        .resumeWaitingForSignature(getSenderId(newPort.sender))
        .then(
          (result) => {
            if (result) {
              postFrame(newPort, {
                id: result.messageId,
                ok: true,
                payload: result.signedDocument,
              });
            }
          },
          (reason) => {
            if (reason?.messageId && reason?.error) {
              postFrame(newPort, {
                id: reason.messageId,
                ok: false,
                payload: serializeRpcError(reason.error),
              });
            }
          }
        )
        .catch((e) => {
          log.error("Error while resuming AVM waitForSignature", e);
        });
    }

    newPort.onDisconnect.addListener((p) => {
      log.debug("Disconnected .....", {
        p,
        lastError: browser.runtime.lastError,
      });

      if (newPort.sender) {
        const senderId = getSenderId(newPort.sender);
        this.handlers.forEach((handler) =>
          handler.abortSender(senderId, "Worker stopped")
        );
        this.avm.abortSenderRequests(senderId);
      }

      newPort.onMessage.removeListener(handleMessage);
    });

    newPort.onMessage.addListener(handleMessage);
  }
}

class AvmExecutor {
  private client = new MobileClient(
    withConfiguredAvmServer(new AutogramVMobileIntegration({ get, set }))
  );
  private restorePoints = new RestorePointStore(
    { get, set },
    this.client,
    // historical key prefix — keeps previously persisted restore points readable
    "autogram:avm:restorePoint:"
  );
  /**
   * Controllers of in-progress signature waits, keyed by sender. Needed in
   * addition to the RPC handler's per-request tracking because resumed
   * waits (after a worker restart) run outside any request context.
   */
  private abortControllers = new Map<SenderId, AbortController>();

  public abortSenderRequests(senderId: SenderId) {
    const abortController = this.abortControllers.get(senderId);
    if (abortController) {
      abortController.abort("Worker stopped");
      this.abortControllers.delete(senderId);
    }
  }

  public async resumeWaitingForSignature(senderId: SenderId): Promise<{
    signedDocument: SignedDocument;
    messageId: string;
  } | null> {
    const waitingForSignature = await get<WaitingForSignatureRecord>(
      dbKeyWaitingForSignature(senderId)
    );
    if (waitingForSignature) {
      const documentRef = await get<AVMIntegrationDocument>(
        waitingForSignature.documentRefDbKey
      );
      if (documentRef) {
        log.debug(
          "Resuming waiting for signature after worker resume",
          senderId,
          documentRef
        );
        try {
          await this.client.init(await getAvmIntegrationRegistrationInfo());

          return {
            signedDocument: await this.waitForSignatureSubroutine(
              documentRef,
              senderId
            ),
            messageId: waitingForSignature.messageId,
          };
        } catch (e) {
          log.error("Error while resuming waitForSignature", e);
          throw { error: e, messageId: waitingForSignature.messageId };
        }
      }
    }
    return null;
  }

  private async waitForSignatureSubroutine(
    documentRef: AVMIntegrationDocument,
    senderId: SenderId,
    externalSignal?: AbortSignal
  ) {
    const request = this.client.resumeRequest(documentRef);
    if (!request) {
      throw new Error("Document guid or key missing");
    }

    const abortController = new AbortController();
    this.abortControllers.set(senderId, abortController);
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener(
          "abort",
          () => abortController.abort(externalSignal.reason),
          { once: true }
        );
      }
    }

    const alarmName = "autogram-signature-timeout-" + senderId;
    browser.alarms.create(alarmName, {
      delayInMinutes: 120,
    });
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === alarmName) {
        log.debug("Alarm triggered", alarm);
        abortController.abort("Timeout");
        browser.alarms.clear(alarmName);
      }
    });

    abortController.signal.addEventListener("abort", () => {
      browser.alarms.clear(alarmName);
      set(dbKeyWaitingForSignature(senderId), undefined);
    });

    const res = await request.waitForSignature({
      signal: abortController.signal,
    });

    browser.alarms.clear(alarmName);
    log.debug("res", res);
    return res;
  }

  /**
   * URL that pairs a phone with this extension. It carries a short-lived
   * token that is sufficient for pairing, so it is only ever handed to
   * extension pages (see {@link BackgroundWorker.onPairingUrlRequest}),
   * never over the page-callable RPC service.
   */
  public async pairingQrCodeUrl(): Promise<string> {
    // the MV3 worker may have restarted since the last init
    await this.client.init(await getAvmIntegrationRegistrationInfo());
    return this.client.pairingQrCodeUrl();
  }

  readonly impl: RpcImpl<typeof avmService.methods> = {
    init: async () => {
      await this.client.init(await getAvmIntegrationRegistrationInfo());
      return null;
    },

    getQrCodeUrl: async (_args, context) => {
      const request = this.client.resumeRequest(
        await get<AVMIntegrationDocument>(dbKeyDocumentRef(context.senderId))
      );
      if (!request) {
        throw new Error("Document not found");
      }
      return request.qrCodeUrl();
    },

    addDocument: async ({ documentToSign, restorePoint }, context) => {
      // Opt-in beta setting: only an explicit `true` enables notifications
      // (stored options from older versions lack the key).
      const { notifyPairedDevices } = await getOptions();
      const request = await this.client.requestSignature(
        documentToSign as unknown as AVMDocumentToSign,
        { notifyDevices: notifyPairedDevices === true }
      );
      await set(dbKeyDocumentRef(context.senderId), request.token);
      if (restorePoint) {
        // bind the restore point to exactly the document uploaded for it
        await this.restorePoints.save(restorePoint, request.token);
      }
      return null;
    },

    sendNotification: async (_args, context) => {
      const request = this.client.resumeRequest(
        await get<AVMIntegrationDocument>(dbKeyDocumentRef(context.senderId))
      );
      if (!request) {
        throw new Error("Document not found");
      }
      await request.notifyDevices();
      return null;
    },

    getPairedDevices: async () => {
      // the MV3 worker may have restarted since init
      await this.client.init(await getAvmIntegrationRegistrationInfo());
      return this.client.pairedDevices();
    },

    waitForSignature: async (_args, context) => {
      const documentRef = await get<AVMIntegrationDocument>(
        dbKeyDocumentRef(context.senderId)
      );
      if (!documentRef) {
        throw new Error("Document not found");
      }

      // persist so the wait can resume if the MV3 worker gets suspended
      await set(dbKeyWaitingForSignature(context.senderId), <
        WaitingForSignatureRecord
      >{
        documentRefDbKey: dbKeyDocumentRef(context.senderId),
        messageId: context.requestId,
      });

      const res = await this.waitForSignatureSubroutine(
        documentRef,
        context.senderId,
        context.signal
      );
      await set(dbKeyWaitingForSignature(context.senderId), undefined);
      return res;
    },

    reset: async ({ restorePoint }, context) => {
      await set(dbKeyDocumentRef(context.senderId), undefined);
      if (restorePoint) {
        // the signing ended while its page was alive: nothing to restore
        await this.restorePoints.remove(restorePoint);
      }
      // TODO: should we abort the request when resetting?
      this.abortControllers.delete(context.senderId);
      browser.alarms.clear("autogram-signature-timeout-" + context.senderId);
      return null;
    },

    useRestorePoint: async ({ restorePoint }, context) => {
      // lookup only — the restore point is created by addDocument, for the
      // document it identifies (never for whatever this sender had before)
      const result = await this.restorePoints.use(restorePoint);
      if (result.outcome !== "signed") {
        return null;
      }
      await set(dbKeyDocumentRef(context.senderId), result.token);
      return result.signedObject;
    },
  };
}

class AutogramExecutor {
  private client: ReturnType<typeof desktopApiClient>;

  constructor() {
    this.client = desktopApiClient({
      serverProtocol: "http",
      serverHost: "localhost",
      disableSecurity: true,
      requestsOrigin: "*",
    });
  }

  readonly impl: RpcImpl<typeof autogramService.methods> = {
    getLaunchURL: async ({ command }) => {
      return this.client.getLaunchURL(command);
    },

    info: async () => {
      return this.client.info();
    },

    waitForStatus: async ({ status, timeout, delay }, context) => {
      return this.client.waitForStatus(
        status,
        timeout,
        delay,
        toAbortController(context.signal)
      );
    },

    signLegacy: async (
      { document, signatureParameters, payloadMimeType, batchId },
      context
    ) => {
      return this.client.signLegacy(
        document,
        signatureParameters,
        payloadMimeType,
        batchId ?? null,
        toAbortController(context.signal)
      );
    },

    signV1: async ({ body }, context) => {
      return this.client.signV1(
        body as DesktopSignRequestBody,
        toAbortController(context.signal)
      );
    },

    startBatch: async ({ totalNumberOfDocuments }, context) => {
      return this.client.startBatch(
        totalNumberOfDocuments,
        toAbortController(context.signal)
      );
    },

    endBatch: async ({ batchId }, context) => {
      return this.client.endBatch(batchId, toAbortController(context.signal));
    },
  };
}

/** Bridges an AbortSignal to the AbortController-based desktop API client. */
function toAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort(signal.reason);
  } else {
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller;
}

function isPairingUrlRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === PAIRING_URL_REQUEST
  );
}

/** A page of this extension (options, popup, the pairing frame). */
function isExtensionPage(sender: browser.Runtime.MessageSender): boolean {
  return (
    sender.id === browser.runtime.id &&
    typeof sender.url === "string" &&
    sender.url.startsWith(browser.runtime.getURL(""))
  );
}

/** One of our content scripts, running in a tab on a supported portal. */
function isSupportedSiteContentScript(
  sender: browser.Runtime.MessageSender | undefined
): boolean {
  if (!sender || sender.id !== browser.runtime.id || !sender.tab) {
    return false;
  }
  if (typeof sender.url !== "string") {
    // not every browser reports it; the id + tab checks above still hold
    return true;
  }
  try {
    supportedSites.matchUrl(sender.url);
    return true;
  } catch {
    return false;
  }
}

type SenderId = string;

function getSenderId(sender: browser.Runtime.MessageSender): SenderId {
  return `${sender.tab?.id?.toString()}|${sender.frameId?.toString()}`;
}

function dbKeyDocumentRef(senderId: SenderId) {
  return `autogram:avm:documentRef:${senderId}`;
}

function dbKeyWaitingForSignature(senderId: SenderId) {
  return `autogram:avm:waitingForSignature:${senderId}`;
}

interface WaitingForSignatureRecord {
  documentRefDbKey: string;
  messageId: string;
}

/**
 * Trust boundary of the background worker: who may connect to the signing
 * bridge, and who may obtain the phone-pairing URL.
 */
const EXTENSION_ID = "test-extension-id";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

jest.mock("webextension-polyfill", () => ({
  __esModule: true,
  default: {
    runtime: {
      id: "test-extension-id",
      getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
      getManifest: () => ({ name: "Autogram" }),
      getPlatformInfo: async () => ({ os: "linux" }),
      onConnect: { addListener: jest.fn() },
      onMessage: { addListener: jest.fn() },
      lastError: undefined,
    },
    alarms: {
      create: jest.fn(),
      clear: jest.fn(),
      onAlarm: { addListener: jest.fn() },
    },
    storage: { local: { get: jest.fn(async (defaults) => defaults) } },
  },
}));
jest.mock("idb-keyval", () => {
  const data = new Map<unknown, unknown>();
  return {
    get: jest.fn(async (key: unknown) => data.get(key)),
    set: jest.fn(async (key: unknown, value: unknown) => {
      data.set(key, value);
    }),
  };
});

import { get } from "idb-keyval";
import { BackgroundWorker } from "./background-worker";
import { PAIRING_URL_REQUEST } from "./background-worker-messages";

const PAIRING_URL = "https://avm.example/qr-code-register?integration=jwt";

function fakePort(sender: object | undefined) {
  return {
    sender,
    disconnect: jest.fn(),
    postMessage: jest.fn(),
    onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
    onDisconnect: { addListener: jest.fn() },
  };
}

type Worker = ConstructorParameters<typeof BackgroundWorker>;

function createWorker() {
  const token = { guid: "doc-1", encryptionKey: "key", lastModified: "now" };
  const avm = {
    pairingQrCodeUrl: jest.fn(async () => PAIRING_URL),
    resumeWaitingForSignature: jest.fn(async () => null),
    abortSenderRequests: jest.fn(),
    impl: {},
  };
  const worker = new BackgroundWorker(
    avm as unknown as Worker[0],
    { impl: {} } as unknown as Worker[1]
  );
  return { worker, avm, token };
}

describe("pairing URL requests", () => {
  const request = { type: PAIRING_URL_REQUEST };

  test("an extension page gets the pairing URL", async () => {
    const { worker } = createWorker();
    await expect(
      worker.onPairingUrlRequest(request, {
        id: EXTENSION_ID,
        url: `${EXTENSION_ORIGIN}static/pairing.html?t=1`,
      })
    ).resolves.toEqual({ ok: true, pairingUrl: PAIRING_URL });
  });

  test("a content script (i.e. anything a web page can reach) does not", async () => {
    const { worker, avm } = createWorker();
    await expect(
      worker.onPairingUrlRequest(request, {
        id: EXTENSION_ID,
        url: "https://www.slovensko.sk/sk/titulna-stranka",
        tab: { id: 1 },
      } as never)
    ).resolves.toEqual({ ok: false });
    expect(avm.pairingQrCodeUrl).not.toHaveBeenCalled();
  });

  test("another extension does not", async () => {
    const { worker, avm } = createWorker();
    await expect(
      worker.onPairingUrlRequest(request, {
        id: "some-other-extension",
        url: `${EXTENSION_ORIGIN}static/pairing.html`,
      })
    ).resolves.toEqual({ ok: false });
    expect(avm.pairingQrCodeUrl).not.toHaveBeenCalled();
  });

  test("unrelated messages are left to other listeners", () => {
    const { worker } = createWorker();
    expect(
      worker.onPairingUrlRequest(
        { bgRuntimeEvent: "onSuspend" },
        { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}static/options.html` }
      )
    ).toBeUndefined();
  });
});

describe("bridge connections", () => {
  test("a content script on a supported portal is accepted", () => {
    const { worker } = createWorker();
    const port = fakePort({
      id: EXTENSION_ID,
      url: "https://schranka.slovensko.sk/Home",
      tab: { id: 7 },
      frameId: 0,
    });
    worker.onConnectListener(port as never);
    expect(port.disconnect).not.toHaveBeenCalled();
    expect(port.onMessage.addListener).toHaveBeenCalled();
  });

  test.each([
    [
      "an unsupported site",
      { id: EXTENSION_ID, url: "https://evil.example/", tab: { id: 7 } },
    ],
    [
      "another extension",
      { id: "other", url: "https://schranka.slovensko.sk/", tab: { id: 7 } },
    ],
    [
      "a sender without a tab",
      { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}static/options.html` },
    ],
    ["no sender at all", undefined],
  ])("%s is disconnected", (_name, sender) => {
    const { worker } = createWorker();
    const port = fakePort(sender);
    worker.onConnectListener(port as never);
    expect(port.disconnect).toHaveBeenCalled();
    expect(port.onMessage.addListener).not.toHaveBeenCalled();
  });
});

describe("the page-callable AVM service", () => {
  test("has no method that returns the pairing URL", async () => {
    const { avmService } = await import("./channel/services");
    expect(Object.keys(avmService.methods)).not.toContain(
      "getPairingQrCodeUrl"
    );
  });

  test("idb mock is wired (sanity)", async () => {
    await expect(get("missing")).resolves.toBeUndefined();
  });
});

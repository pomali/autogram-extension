import { decodeJwt } from "jose";
import { AvmSimpleChannel } from "./channel-avm";
import { supportsNotifications } from "./flow";
import type { DBInterface } from "./avm-api/lib/apiClient";

function memoryDb(): DBInterface & { data: Map<IDBValidKey, unknown> } {
  const data = new Map<IDBValidKey, unknown>();
  return {
    data,
    set: async (key, value) => {
      data.set(key, value);
    },
    get: async <T>(key: IDBValidKey) => data.get(key) as T | undefined,
  };
}

describe("AvmSimpleChannel", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("implements the notifications capability", () => {
    expect(supportsNotifications(new AvmSimpleChannel())).toBe(true);
  });

  test("uses the injected storage for the integration identity", async () => {
    const storage = memoryDb();
    storage.data.set(
      "keyPair",
      await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"]
      )
    );
    storage.data.set("integrationGuid", "stored-guid");

    const requests: Request[] = [];
    globalThis.fetch = jest.fn(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response("[]", {
        headers: { "Content-Type": "application/json" },
      });
    });

    const channel = new AvmSimpleChannel({ storage });
    // identity found in storage: no registration request
    await channel.init({ platform: "test" });
    expect(requests).toHaveLength(0);

    await expect(channel.getPairedDevices()).resolves.toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toMatch(/\/integration-devices$/);
    const jwt = requests[0].headers
      .get("Authorization")!
      .replace("Bearer ", "");
    expect(decodeJwt(jwt).sub).toBe("stored-guid");
  });
});

/**
 * A fake AVM server: `POST /documents` creates a document, `GET
 * /documents/{guid}` answers from `statusOf` (default: 304 = pending).
 */
function fakeAvmServer() {
  const server = {
    uploaded: [] as string[],
    polls: [] as string[],
    statusOf: (_guid: string): Response => new Response(null, { status: 304 }),
  };
  globalThis.fetch = jest.fn(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/documents")) {
      const guid = `doc-${server.uploaded.length + 1}`;
      server.uploaded.push(guid);
      return new Response(JSON.stringify({ guid }), {
        headers: {
          "Content-Type": "application/json",
          "Last-Modified": "Mon, 01 Jun 2026 00:00:00 GMT",
        },
      });
    }
    const guid = url.pathname.split("/").pop()!;
    server.polls.push(guid);
    return server.statusOf(guid);
  });
  return server;
}

const signedResponse = () =>
  new Response(
    JSON.stringify({
      filename: "a.asice",
      mimeType: "application/vnd.etsi.asic-e+zip",
      content: "c2lnbmVk",
      signers: [{ signedBy: "CN=A", issuedBy: "CN=B" }],
    }),
    { headers: { "Content-Type": "application/json" } }
  );

const DOCUMENT = {
  document: { content: "<a/>" },
  parameters: {},
  payloadMimeType: "application/xml",
} as Parameters<AvmSimpleChannel["addDocument"]>[0];

describe("AvmSimpleChannel signing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.useRealTimers();
  });

  function channelWithStorage() {
    const storage = memoryDb();
    const channel = new AvmSimpleChannel({ storage, notifyDevices: false });
    return { storage, channel };
  }

  test("the caller's abort controller stops waiting for the signature", async () => {
    const server = fakeAvmServer();
    const { channel } = channelWithStorage();
    await channel.addDocument(DOCUMENT);

    const abortController = new AbortController();
    const waiting = channel.waitForSignature(abortController);
    // let the first poll happen, then close the dialog
    await new Promise((resolve) => setTimeout(resolve, 20));
    abortController.abort("User closed signing screen");

    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    const pollsWhenAborted = server.polls.length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // …and the polling really stopped
    expect(server.polls.length).toBe(pollsWhenAborted);
  });

  test("a network blip while polling does not lose the signature", async () => {
    jest.useFakeTimers();
    const server = fakeAvmServer();
    const { channel } = channelWithStorage();
    await channel.addDocument(DOCUMENT);

    const answers: Array<() => Response> = [
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => new Response("bad gateway", { status: 502 }),
      signedResponse,
    ];
    server.statusOf = () => (answers.shift() ?? signedResponse)();

    const waiting = channel.waitForSignature();
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(waiting).resolves.toMatchObject({ content: "c2lnbmVk" });
    expect(server.polls).toHaveLength(3);
  });

  test("a document that is gone ends the wait with a timeout error", async () => {
    jest.useFakeTimers();
    const server = fakeAvmServer();
    const { channel } = channelWithStorage();
    await channel.addDocument(DOCUMENT);
    server.statusOf = () => new Response(null, { status: 404 });

    const waiting = channel.waitForSignature().catch((e) => e);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await waiting).toMatchObject({ code: "timeout" });
  });

  test("a restore point is bound to the document uploaded for it, never to an earlier request", async () => {
    const server = fakeAvmServer();
    const { channel, storage } = channelWithStorage();

    // signing A is started and abandoned without a reset (pre-fix: its
    // request was what the next restore point got bound to)
    await channel.addDocument(DOCUMENT);
    expect(server.uploaded).toEqual(["doc-1"]);

    // signing B, identified by restore point "rp-B"
    await expect(channel.useRestorePoint("rp-B")).resolves.toBeNull();
    expect(storage.data.get("restorePoint:rp-B")).toBeUndefined();
    await channel.addDocument(DOCUMENT);
    expect(storage.data.get("restorePoint:rp-B")).toMatchObject({
      guid: "doc-2",
    });

    // the page reloads; A gets signed on the phone, B does not
    server.statusOf = (guid) =>
      guid === "doc-1" ? signedResponse() : new Response(null, { status: 304 });
    const reloaded = new AvmSimpleChannel({ storage, notifyDevices: false });
    await expect(reloaded.useRestorePoint("rp-B")).resolves.toBeNull();

    // once B itself is signed, the restore point delivers it
    server.statusOf = () => signedResponse();
    const reloadedAgain = new AvmSimpleChannel({
      storage,
      notifyDevices: false,
    });
    await expect(reloadedAgain.useRestorePoint("rp-B")).resolves.toMatchObject({
      content: "c2lnbmVk",
    });
  });

  test("reset forgets the restore point of a signing that ended in this page", async () => {
    fakeAvmServer();
    const { channel, storage } = channelWithStorage();
    await channel.useRestorePoint("rp-1");
    await channel.addDocument(DOCUMENT);
    expect(storage.data.get("restorePoint:rp-1")).toBeDefined();

    await channel.reset();
    expect(storage.data.get("restorePoint:rp-1")).toBeUndefined();
  });
});

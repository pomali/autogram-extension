import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

/**
 * Port the e2e build of the extension expects the Autogram v mobile (AVM)
 * server on — `AE_AVM_BASE_URL` in the `vite:build-e2e` script.
 */
export const FAKE_AVM_PORT = 37201;
export const FAKE_AVM_BASE_URL = `http://localhost:${FAKE_AVM_PORT}/api/v1`;

export interface FakeAvmDocument {
  guid: string;
  /** `X-Encryption-Key` the document was uploaded with */
  encryptionKey: string;
  /** parsed `POST /documents` body */
  request: {
    document: { content: string; filename?: string };
    parameters?: Record<string, unknown>;
    payloadMimeType?: string;
  };
  signed: boolean;
  /** `GET /documents/{guid}` requests answered for this document */
  polls: number;
}

export interface FakeAvmDevice {
  deviceId: string;
  platform: string;
  displayName: string;
}

export interface FakeAvmServer {
  /** Uploaded documents, in upload order. */
  documents: FakeAvmDocument[];
  /** GUIDs of the registered integrations, in registration order. */
  integrations: string[];
  /** Push notifications requested through `POST /sign-request`. */
  notifications: { integrationGuid: string; documentGuid: string }[];
  /** Base64 content every signed document is returned with. */
  signedContent: string;

  /** The user signs the document on the phone. */
  signDocument(guid: string): void;
  /** The server forgets the document (as it does 24 h after upload). */
  expireDocument(guid: string): void;
  /** A phone scans the pairing QR code of the integration. */
  pairDevice(integrationGuid: string, device?: Partial<FakeAvmDevice>): void;
  /**
   * Fail the next `count` document polls: `"drop"` closes the connection
   * without a response (what a network outage looks like to `fetch`),
   * `"error"` answers 502.
   */
  failNextPolls(count: number, how: "drop" | "error"): void;
  /** Forget everything — call between tests. */
  reset(): void;
  close(): Promise<void>;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  // the client reads the document's Last-Modified to poll conditionally
  "Access-Control-Expose-Headers": "Last-Modified",
};

/**
 * Stand-in for the Autogram v mobile server and, through its control
 * methods, for the phone. Implements the integration-facing API the
 * extension's background worker uses:
 *
 *   POST   /integrations                  register an integration
 *   GET    /integration-devices           paired devices (Bearer JWT)
 *   DELETE /integration-devices/{id}      unpair
 *   POST   /documents                     upload a document to sign
 *   GET    /documents/{guid}              304 pending · 200 signed · 404
 *   POST   /sign-request                  push notification to paired devices
 *
 * JWTs are decoded, not verified: the fake only needs to know which
 * integration is calling.
 */
export function startFakeAvmServer(): Promise<FakeAvmServer> {
  const devices = new Map<string, FakeAvmDevice[]>();
  let pollFailures: { count: number; how: "drop" | "error" } | null = null;
  const sockets = new Set<Socket>();

  const state: FakeAvmServer = {
    documents: [],
    integrations: [],
    notifications: [],
    signedContent: Buffer.from("<e2e-fake-avm-signed-container/>").toString(
      "base64"
    ),
    signDocument(guid) {
      findDocument(guid).signed = true;
    },
    expireDocument(guid) {
      const index = state.documents.indexOf(findDocument(guid));
      state.documents.splice(index, 1);
    },
    pairDevice(integrationGuid, device = {}) {
      if (!state.integrations.includes(integrationGuid)) {
        throw new Error(`fake AVM: unknown integration ${integrationGuid}`);
      }
      const paired = devices.get(integrationGuid) ?? [];
      paired.push({
        deviceId: randomUUID(),
        platform: "android",
        displayName: "E2E Phone",
        ...device,
      });
      devices.set(integrationGuid, paired);
    },
    failNextPolls(count, how) {
      pollFailures = { count, how };
    },
    reset() {
      state.documents.length = 0;
      state.integrations.length = 0;
      state.notifications.length = 0;
      devices.clear();
      pollFailures = null;
    },
    close: () =>
      new Promise((resolve, reject) => {
        sockets.forEach((socket) => socket.destroy());
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };

  function findDocument(guid: string): FakeAvmDocument {
    const document = state.documents.find((d) => d.guid === guid);
    if (!document) {
      throw new Error(`fake AVM: unknown document ${guid}`);
    }
    return document;
  }

  /** `sub` of the Bearer JWT = the calling integration's GUID. */
  function callingIntegration(req: http.IncomingMessage): string | null {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const payload = token?.split(".")[1];
    if (!payload) {
      return null;
    }
    try {
      const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf-8")
      );
      return typeof claims.sub === "string" ? claims.sub : null;
    } catch {
      return null;
    }
  }

  function json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    });
    res.end(JSON.stringify(body));
  }

  function empty(res: http.ServerResponse, status: number) {
    res.writeHead(status, CORS_HEADERS);
    res.end();
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", FAKE_AVM_BASE_URL).pathname.replace(
      /^\/api\/v1/,
      ""
    );

    if (method === "OPTIONS") {
      return empty(res, 204);
    }

    if (method === "POST" && path === "/integrations") {
      await readBody(req);
      const guid = randomUUID();
      state.integrations.push(guid);
      return json(res, 200, { guid });
    }

    if (path === "/integration-devices" && method === "GET") {
      const integration = callingIntegration(req);
      if (!integration || !state.integrations.includes(integration)) {
        return json(res, 401, { code: "UNAUTHORIZED", message: "Unknown JWT" });
      }
      return json(res, 200, devices.get(integration) ?? []);
    }

    const deviceMatch = /^\/integration-devices\/([^/]+)$/.exec(path);
    if (deviceMatch && method === "DELETE") {
      const integration = callingIntegration(req);
      const paired = (integration && devices.get(integration)) || [];
      const index = paired.findIndex(
        (d) => d.deviceId === decodeURIComponent(deviceMatch[1])
      );
      if (index === -1) {
        return empty(res, 404);
      }
      paired.splice(index, 1);
      return empty(res, 204);
    }

    if (method === "POST" && path === "/documents") {
      const request = JSON.parse(await readBody(req));
      const guid = randomUUID();
      state.documents.push({
        guid,
        encryptionKey: String(req.headers["x-encryption-key"] ?? ""),
        request,
        signed: false,
        polls: 0,
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Last-Modified": new Date().toUTCString(),
        ...CORS_HEADERS,
      });
      res.end(JSON.stringify({ guid }));
      return;
    }

    const documentMatch = /^\/documents\/([^/]+)$/.exec(path);
    if (documentMatch && method === "GET") {
      if (pollFailures && pollFailures.count > 0) {
        pollFailures.count--;
        if (pollFailures.how === "drop") {
          req.socket.destroy();
          return;
        }
        return json(res, 502, { code: "BAD_GATEWAY", message: "E2E outage" });
      }
      const document = state.documents.find((d) => d.guid === documentMatch[1]);
      if (!document) {
        return empty(res, 404);
      }
      document.polls++;
      if (req.headers["x-encryption-key"] !== document.encryptionKey) {
        return json(res, 403, { code: "FORBIDDEN", message: "Wrong key" });
      }
      if (!document.signed) {
        return empty(res, 304);
      }
      return json(res, 200, {
        filename: "document.asice",
        mimeType: "application/vnd.etsi.asic-e+zip",
        content: state.signedContent,
        signers: [
          { signedBy: "CN=E2E Mobile Signer, C=SK", issuedBy: "CN=E2E CA" },
        ],
      });
    }

    if (method === "POST" && path === "/sign-request") {
      const integration = callingIntegration(req);
      const body = JSON.parse(await readBody(req));
      if (!integration || !state.integrations.includes(integration)) {
        return json(res, 401, { code: "UNAUTHORIZED", message: "Unknown JWT" });
      }
      state.notifications.push({
        integrationGuid: integration,
        documentGuid: body.documentGuid,
      });
      return empty(res, 204);
    }

    return json(res, 404, { code: "NOT_FOUND", message: `${method} ${path}` });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`port ${FAKE_AVM_PORT} (fake AVM server) is taken`)
          : error
      );
    });
    server.listen(FAKE_AVM_PORT, () => resolve(state));
  });
}

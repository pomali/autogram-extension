# Security Review — autogram-extension monorepo

**Scope:** `autogram-sdk`, `autogram-extension`, `example-avm-integration`, `example-extension-usage`, build/CI config.
**Commit reviewed:** `ec77554` (sdk update demos and docs, #190)
**Method:** manual source review of every runtime path, plus dependency and secret scanning. No dynamic testing was performed.

**Out of scope (and therefore assumed, not verified):** the Autogram desktop application (`localhost:37200`), the Autogram v Mobile server (`autogram.slovensko.digital`), the AVM phone app, and the government portals themselves. Several conclusions below depend on controls that must exist in those components; where that is the case it is stated explicitly, because the client-side code in this repository does not enforce them.

---

## 1. Threat model

### 1.1 What the system does

Two products share one codebase:

**A. The extension** (main user population). Users install it so that Slovak government portals — which were built against the proprietary DITEC *D.Signer/D.Bridge* Java applet — keep working. The extension injects a JavaScript object that impersonates `window.ditec`, captures the portal's sign requests, and routes them to either the Autogram desktop app (smartcard/eID reader) or Autogram v Mobile (phone).

**B. The SDK** (used directly by websites). Integrators import `autogram-sdk` and call `CombinedClient.sign(...)` from their own page. There is no extension and no content script; everything runs in the website's own origin.

### 1.2 Data flow

```
                        ┌─────────── EXTENSION PATH ───────────┐

 gov portal page (page world)                                        privileged
 ┌──────────────────────────────┐                            ┌────────────────────┐
 │ portal JS  →  window.ditec   │                            │ background worker  │
 │            (autogram-inject) │                            │  - desktop client  │
 │  + injected consent dialog   │                            │  - AVM client      │
 └──────────────┬───────────────┘                            │  - IndexedDB       │
                │ CustomEvent on window                      └─────────┬──────────┘
                │ (same JS world — NOT a boundary)                     │
        ┌───────▼────────┐        chrome.runtime.Port                  │
        │ content script │ ◄──────────────────────────────────────────►┘
        └────────────────┘        (real boundary #1)
                                                                       │
                        ┌───────── SDK PATH ─────────┐                 │
                                                                       │
 integrator's page                                                     │
 ┌──────────────────────────────┐                                      │
 │ CombinedClient (page origin) │──────────────────────────────────────┤
 │  keys + state in page IDB    │                                      │
 └──────────────────────────────┘                                      │
                                                                       ▼
                                              ┌────────────────────────────────────┐
                                              │ http://localhost:37200  (desktop)  │  boundary #2
                                              │ autogram://listen       (protocol) │
                                              │ https://autogram.slovensko.digital │  boundary #3
                                              └────────────────────────────────────┘
```

### 1.3 Assets

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | **Integrity of what gets signed** | A qualified electronic signature is legally binding. Signing the wrong bytes is the worst outcome in the system. |
| A2 | **Confidentiality of documents** | Tax filings, court submissions, mailbox contents. Often contain personal and financial data. |
| A3 | **Signed documents (output)** | A signed document leaked to a third party is a disclosure *and* a potentially reusable artifact. |
| A4 | **AVM integration private key** (ES256) | Authenticates this browser to the AVM server; authorizes sending sign-requests/push notifications to the user's paired phone. |
| A5 | **AVM document GUID + AES key pair** | Together they are a bearer credential: whoever holds both can read the document and its signature from the AVM server. |
| A6 | **Access to the local signer** (`localhost:37200`) | Anything that can reach it can ask the user's eID to sign. |
| A7 | **User's ability to make an informed decision** | The consent UI is what stands between a request and a signature. |

### 1.4 Actors

| Actor | Capability assumed |
|-------|--------------------|
| **T1 — Malicious website** | Any origin the user visits. Cannot run in an allowlisted origin. |
| **T2 — Compromised/XSS'd allowlisted portal** | Full JS execution in one of the ~13 origins in `supported-sites.ts`. Includes a malicious third‑party script (analytics, ads, CDN) on such a portal. |
| **T3 — Malicious integrator / XSS on an SDK-using site** | Full JS execution in a site using the SDK directly. |
| **T4 — Local unprivileged process** | Any other program on the user's machine; can reach `localhost:37200`. |
| **T5 — Network attacker** | On-path for `https://autogram.slovensko.digital`. TLS assumed to hold. |
| **T6 — AVM server operator / anyone who compromises it** | Holds whatever the client sends it. |
| **T7 — Supply chain** | npm dependency compromise; extension store update channel. |
| **T8 — Other extension / other tab** | Another extension in the same browser, or a second tab. |

### 1.5 Trust boundaries

| Boundary | Between | Enforced by | Assessment |
|---|---|---|---|
| **B1** | Web page ↔ injected script | *nothing* | **Not a boundary.** `autogram-inject.bundle.js` runs in the page's JS world. Portal JS can read, replace, or drive every part of it, including the consent dialog. This is inherent to emulating `window.ditec` and is not a defect by itself — but it means everything downstream must assume the page is the caller. |
| **B2** | Content script ↔ background worker | `chrome.runtime.Port` + zod schemas | Real boundary. Message *shape* is validated; message *origin* is not (§F5). |
| **B3** | Extension ↔ desktop app | Custom protocol handshake (`key`, `nonce`, `origin`) | **Deliberately disabled** (§F1). |
| **B4** | Extension/SDK ↔ AVM server | ES256 JWT bearer; `X-Encryption-Key` header | Real, but the server is trusted with plaintext and with the document key (§F6). |
| **B5** | Origin ↔ origin *inside* the extension | *nothing* | **Missing.** All allowlisted origins share one IndexedDB and one AVM identity, keyed only by tab/frame id (§F2, §F3). |
| **B6** | Which sites can talk to the extension at all | `matches` in the manifest = `supported-sites.ts` | The single most load-bearing control in the design. Correctly scoped to explicit HTTPS origins; no wildcards, no `<all_urls>`. Debug origins (`localhost`, `127.0.0.1`) are correctly gated behind `NODE_ENV !== "production"`. |

### 1.6 Security goals, and where they stand

| Goal | Status |
|---|---|
| G1 — A signature is produced only after a deliberate user action | **Partially met.** The in-browser dialog is defeatable by the host page (§F7); the user's real consent gate is the desktop app / phone, which is outside this repo. |
| G2 — What the user is shown is what gets signed (WYSIWYS) | **Delegated.** The page supplies both the data *and* the XSLT that renders it (§F8). Binding those to a registered eForm is the signer's job, not this code's — but nothing here checks it either. |
| G3 — Only the extension may drive the local signer | **Not met** (§F1). |
| G4 — One origin cannot reach another origin's documents | **Not met** (§F2, §F3). |
| G5 — Long-lived key material is protected from the page | **Not met in the SDK path** (§F4). Met in the extension path. |
| G6 — Documents are confidential end-to-end | **Not a goal of the current design.** The AVM server receives plaintext and the key (§F6). |

### 1.7 Attacks explicitly considered and *not* found viable

- **T1 (arbitrary website) → extension.** `externally_connectable` is commented out, so no web page can `runtime.connect`. Content scripts only run on allowlisted origins. A random site cannot reach the background worker. This is correct and important.
- **DOM XSS in the consent UI.** All interpolations in the Lit templates (`errorMessage`, `state.message`, titles) are escaped by Lit. `unsafeSVG` is used only on compile-time-constant SVG and on bwip-js QR output. No sink found.
- **`javascript:` URL in the QR/deep-link anchor.** `url` is always built from the hardcoded `https://autogram.slovensko.digital/api/v1` base. Not attacker-controlled today (see §F14 for the hardening note).
- **Hardcoded secrets.** None. The only Sentry DSN is a localhost one, active only in non-production builds.

---

## 2. Findings

Severity reflects impact on the assets above combined with how much attacker capability is required.

| ID | Finding | Severity |
|----|---------|----------|
| F1 | Local signer accepts requests from any origin and any local process | **High** |
| F2 | Extension AVM state is keyed by tab/frame id, shared across all origins and sessions | **High** |
| F3 | Restore points are a global, unauthenticated, non-expiring namespace | **High** (opt-in) |
| F4 | AVM integration private key is extractable and stored in the page's origin (SDK path) | **High** |
| F5 | Background worker does not validate message sender; dispatches on an unvalidated method name | **Medium** |
| F6 | Document encryption key and integration JWT are handed to the server, including via URL | **Medium** |
| F7 | The in-page consent dialog can be auto-confirmed by the host page | **Medium** |
| F8 | Page-supplied XSLT/XSD are forwarded unbound to the declared form identifier | **Medium** |
| F9 | Google Fonts are injected into every government page and the options page | **Medium** (privacy) |
| F10 | Unused `isomorphic-webcrypto` and browserify polyfills enlarge the shipped supply chain | **Medium** |
| F11 | Signing errors are swallowed; the calling page is never told | **Low** |
| F12 | `AbortController` state, alarm listeners and IndexedDB records leak | **Low** |
| F13 | Selector injection from `localStorage` in the UPVS mobile fixes | **Low** |
| F14 | Assorted hardening: prod source maps, malformed MV2 `web_accessible_resources`, no URL scheme check, production error reporting disabled | **Low** |
| F15 | Example apps render server-controlled data via `innerHTML` and are publicly deployed | **Low** |
| F16 | 110 npm advisories, all in dev/build tooling | **Informational** |

---

### F1 — Local signer accepts requests from any origin and any local process — **High**

`autogram-extension/src/dbridge_js/autogram/background-worker.ts:436-446`, `autogram-sdk/src/channel-desktop.ts:28-33`, `autogram-sdk/src/entrypoint/../autogram-api/lib/apiClient.ts:48-103`, `autogram-extension/src/entrypoint/redirect.ts:11-13`

Every client in this repository launches the desktop app with security switched off:

```ts
// background-worker.ts:440
this.client = desktopApiClient({
  serverProtocol, serverHost,
  disableSecurity: true,
  requestsOrigin: "*",
});
```

`redirect.ts` does the same via a literal URL: `autogram://listen?protocol=http&host=localhost&port=37200&origin=*&language=sk`.

Two separate problems compound here:

1. **`origin: "*"` is sent deliberately.** The protocol supports pinning the desktop app to a single origin. Every caller here opts out. Once the app is listening, its CORS policy is `*`, so **any** website the user has open can `POST http://localhost:37200/sign` directly — no extension, no allowlist, no content script. Any local process (T4) can do the same, without even a browser.

2. **The HMAC the API documents does not exist.** `apiClient()` generates a 256-bit `secretKey` and a 32-bit `secretInitialNonce` (lines 56-57), puts them in the launch URL (lines 93-100) — and then never uses them again. Grepping the SDK for HMAC computation returns nothing; the authors' own TODOs at lines 62-64 confirm it was never finished:

   ```ts
   // TODO: We should keep it as 32-bit int that can overflow back to minimum value
   // TODO: There is one nonce for each sensitive point like sign
   ```

   The doc comment on `disableSecurity` (line 347) reads *"Disables using of HMAC in messages"* — there is no HMAC to disable. An integrator who reads the API surface, leaves `disableSecurity` at its safe default of `false`, and believes their requests are authenticated, is wrong.

**Impact (A6, A1):** the only thing standing between a hostile local process or an arbitrary website and a signature request reaching the user's eID is the desktop app's own confirmation dialog. That may well be sufficient — but it is an assumption about a component outside this repo, and the defence-in-depth the protocol was designed to provide is switched off at every call site.

**Recommendation:**
1. Stop sending `origin=*`. In the extension, the background worker knows `sender.url`; pass that origin. In the SDK, use `location.origin` (already the default in `configurationDefaults`).
2. Either implement the HMAC/nonce scheme end-to-end, or delete `secretKey`, `secretInitialNonce` and `disableSecurity` from the public API and the docs. Shipping an inert security parameter is worse than shipping none, because integrators rely on it.
3. If the desktop app can bind to a per-session token, do that instead and treat the token as a capability.

---

### F2 — Extension AVM state is keyed by tab/frame id, shared across all origins and sessions — **High**

`autogram-extension/src/dbridge_js/autogram/background-worker.ts:629-665`, `291-330`

```ts
function getSenderId(sender): SenderId {
  return `${sender.tab?.id?.toString()}|${sender.frameId?.toString()}`;
}
function dbKeyDocumentRef(senderId) { return `autogram:avm:documentRef:${senderId}`; }
```

The document reference — `{ guid, encryptionKey, lastModified }`, which together are a bearer credential for reading the document and its signature from the AVM server (A5) — is stored in the **extension's** IndexedDB under a key derived only from tab id and frame id. There is no origin component.

Consequences:

- **Cross-origin.** Tab 7 signs on `slovensko.sk`; the user then navigates the same tab to `financnasprava.sk`. The second portal calls `getQrCodeUrl` or `waitForSignature` without calling `addDocument`, and the worker happily serves it the first portal's document ref (`background-worker.ts:291-296, 310-313`). `waitForSignature` returns the **full signed document content**.
- **Cross-session.** IndexedDB survives browser restarts; tab ids do not — they restart from low numbers. A document ref written under `...:5|0` yesterday is readable by whatever page happens to occupy tab 5 today.
- **Never cleaned up.** `reset` calls `set(key, undefined)` rather than `del(key)` (line 344), so records linger.

**Who can exploit it:** T2 — a compromised or XSS'd allowlisted portal, or a malicious third-party script on one. Not T1: an arbitrary website has no content script and cannot reach the worker. But the extension's whole design is "trust these 13 origins", and behind that line there is currently no isolation at all. It is also reachable by accident, without any attacker, through ordinary tab reuse.

**Recommendation:** key all per-request state on the sender's **origin** (from `port.sender.url`), not on tab/frame ids — or better, on `origin + tabId + frameId` so that a same-origin navigation in a reused tab still cannot pick up a stale document. Use `del()` on reset, and expire records on a timer.

---

### F3 — Restore points are a global, unauthenticated, non-expiring namespace — **High** (gated behind an opt-in beta flag)

`autogram-extension/src/dbridge_js/autogram/background-worker.ts:350-430`, `autogram-extension/src/dbridge_js/autogram/autogram-implementation.ts:32-69, 166-187`

```ts
const dbKeyRestorePoint = `autogram:avm:restorePoint:${restorePoint}`;
```

`restorePoint` is a string that arrives from the page (via `ZUseRestorePointArgs`, which validates only that it is a string). If a stored entry exists and the document is signed, the worker returns **the document content, signers and issuers directly to the caller** (lines 398-417).

The identifier is a SHA-256 over `{signatureParams, digestAlgUri, objectId, documentContent, url, ...}` (`autogram-implementation.ts:45-68`) — but that is a *convention of the honest caller*, not something the worker verifies. A caller can pass any string. Anything that knows or can reconstruct another origin's restore-point hash retrieves that origin's signed document. The `url` in the hash input makes it origin-*derived* but not origin-*bound*: the hash is computed page-side and the worker never checks it against `sender.url`.

Two additional defects in the same function:

- Line 362-370: when no restore point exists, the code stores `dbKeyDocumentRef(senderId)` — the **key string**, i.e. `"autogram:avm:documentRef:5|0"` — not the document ref itself. The guard `if (documentRefKey)` is always true (it is a template literal). So a restore point permanently aliases a *tab slot*; later resolution returns whatever document that slot holds at that moment. This is F2's confused-deputy problem with a longer lifetime.
- Line 406: the cleanup (`await set(dbKeyRestorePoint, undefined)`) is commented out, so entries never expire. The parallel SDK implementation in `channel-avm.ts:110` *does* clean up — the two paths have diverged.

**Mitigating factor:** `restorePointEnabled` defaults to `false` (`options/default.ts:4`) and is labelled beta in the options UI. Practical exposure today is limited to users who opted in. The finding is rated on what happens when it ships enabled.

**Recommendation:** namespace restore points by sender origin (`autogram:avm:restorePoint:${origin}:${hash}`); store the document ref, not the key string; restore the TTL/cleanup; and recompute or verify the hash worker-side against `sender.url` rather than trusting the page's string.

---

### F4 — AVM integration private key is extractable and stored in the page's origin (SDK path) — **High**

`autogram-sdk/src/avm-api/lib/apiClient.ts:268-296`

```ts
const keyPair = await this.subtleCrypto.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,                       // ← extractable
  ["sign", "verify"]
);
...
private async saveKeyPair(keyPair: CryptoKeyPair) {
  return this.db.set("keyPair", keyPair); // TODO: toto je zle, lebo zapisujeme v kontexte webu, nie rozsirenia
}
```

The authors' own comment on line 286 identifies the problem ("this is wrong, because we're writing in the context of the web, not the extension"). Two things are wrong:

1. **`extractable: true`.** There is no code path that exports the private key — only `exportKey("spki", publicKey)` (line 316) and `exportKey("raw", documentKey)` (line 265), neither of which needs the private key to be extractable. WebCrypto `CryptoKey` objects are structured-cloneable into IndexedDB *even when non-extractable*, so this flag buys nothing and costs the ability to exfiltrate raw key material.
2. **Stored in the caller's origin.** In the extension path this lands in the extension's own IndexedDB, which is fine. In the SDK path (`channel-avm.ts:19-22`, and the same `AutogramVMobileIntegration` constructed directly in `example-avm-integration/src/index.ts:31`) it lands in the *website's* IndexedDB.

**Impact (A4):** any XSS on a site that integrates the SDK directly — T3 — reads `keyPair` out of IndexedDB and, because it is extractable, exports the raw private key. That key is the integration's identity to the AVM server: it signs the bearer JWTs used to `POST /documents` and `POST /sign-request` (lines 240-262, 560-575), i.e. it can push signing requests and notifications to the user's paired phone from anywhere, indefinitely (the key has no expiry; only the JWTs do, at 5 minutes).

**Recommendation:** generate with `extractable: false`. Document clearly in the SDK README that direct SDK use places the integration identity in the integrating site's origin, and that the integration is therefore only as trustworthy as that site's XSS posture. Consider server-side integration registration for high-value integrators.

---

### F5 — Background worker does not validate message sender; dispatches on an unvalidated method name — **Medium**

`autogram-extension/src/dbridge_js/autogram/background-worker.ts:120-139, 190-192, 451-453`

```ts
const handleMessage = (request, port) => {
  const sender = port.sender;
  if (!sender) throw new Error("Sender not found");
  const senderId = getSenderId(sender);      // tab|frame only — url never read
  const data = ZChannelMessage.parse(request);
  ...
  app.run(data, senderId)
};
...
public async run(data: ChannelMessage, senderId: SenderId) {
  return this.methods[data.method](data.args, senderId, data.id);
}
```

- **`sender.url` is never inspected.** The manifest currently constrains which pages get a content script, so the practical exposure is low — but the worker has the origin available and discards it, which is exactly what F2 and F3 need in order to be fixed. Reading it here is the single change that unblocks both.
- **`this.methods[data.method]`** is an unvalidated property lookup on a plain object with `Object.prototype` in its chain. `method: "constructor"` resolves to `Object` and is called; `method: "toString"` returns a string; `method: "__proto__"` throws a `TypeError`. None of these reach `Function`, so this is **not** remote code execution — but it is unbounded dynamic dispatch on attacker-controlled input, and it is one refactor away from being worse. `ZChannelMessage.method` is only `z.string()`.
- `handleMessage` is synchronous and `ZChannelMessage.parse` throws on malformed input, producing an uncaught exception inside the port listener rather than a structured error back to the caller.

**Recommendation:** validate `sender.url` against `supportedSites` and reject otherwise; constrain `method` with `z.enum([...])`; use `Object.hasOwn(this.methods, method)` or a `switch`; wrap `handleMessage` so parse failures return an error response.

---

### F6 — Document encryption key and integration JWT are handed to the server, including via URL — **Medium**

`autogram-sdk/src/avm-api/lib/apiClient.ts:474-507, 577-594, 78-103`

```ts
headers: {
  Authorization: "Bearer " + bearerToken,
  "X-Encryption-Key": documentEncryptionKey,   // client-generated AES-256-GCM key
},
body: JSON.stringify(data),                     // plaintext document
```

The AES key is generated client-side (line 320-330), which *looks* like end-to-end encryption, but it is sent to the server alongside the plaintext document. The server therefore holds both. It is at-rest encryption under a per-document key, not E2E — a legitimate design choice, but the naming invites the opposite reading, and `getQrCodeUrl` then puts the same key into a **URL query string**:

```ts
return this.apiClient.qrCodeUrl({ guid: doc.guid, key: doc.encryptionKey, ...integrationObj });
// → https://autogram.slovensko.digital/api/v1/qr-code?guid=…&key=…&integration=<JWT>
```

That URL is rendered as a QR code *and* as a clickable `<a href>` (`sign-mobile.screen.ts:79`, `sign-mobile-on-mobile.screen.ts:26`). On `getSignatureMobileOnMobile` it is additionally passed to `window.open` (`with-ui.ts:316`). Query strings land in server access logs, proxy logs, and browser history far more readily than headers or bodies do. The `integration` parameter is a signed JWT with `aud: "device"` — a credential, in a URL.

**Impact (A2, A5):** T6 has full access by design; the incremental risk is that A5 and the integration JWT are duplicated into logging surfaces that are not treated as secret storage.

**Recommendation:** document the trust placed in the AVM server plainly in the SDK README, so integrators do not mistake this for E2E. Move the key and JWT out of the query string (fragment, POST-then-redirect, or a short-lived opaque handle). The JWT's 5-minute expiry limits the damage; the document key has no expiry at all.

---

### F7 — The in-page consent dialog can be auto-confirmed by the host page — **Medium**

`autogram-sdk/src/injected-ui/main.ts:31-33, 131-137, 271-295`, `autogram-sdk/src/injected-ui/events.ts:7-15`

`<autogram-root>` is a Lit element appended to the host page's `document.body`. Lit's default shadow root mode is **open**, and the choice events are declared `bubbles: true, composed: true`:

```ts
export class EventChoice extends CustomEvent<{ method: SigningMethod }> {
  constructor(method) { super("autogram-choice", { detail: { method }, bubbles: true, composed: true }); }
}
```

So page JS can do `document.querySelector("autogram-root").shadowRoot.querySelector(...)` and click, or simply dispatch a matching `CustomEvent` — and `_handleChoice` resolves `choiceResult` (line 131-137), skipping the user's selection entirely. The page can equally `.remove()` the element to deny signing.

The `inert`-stripping `MutationObserver` (lines 277-283) is a legitimate workaround for host pages that trap focus, but it underlines the point: the dialog exists at the host page's mercy.

**Assessment.** This is not a bug to be fixed inside the dialog — B1 means the page always wins in its own world, and no amount of shadow DOM changes that. It matters because of what is *inferred* from the dialog. Note what the dialog does **not** show: it never displays the document. So a page that auto-confirms only skips the "reader or phone?" question; the user still sees and approves the document in the desktop app or on their phone. That is a sound division of labour and should be preserved deliberately.

**Recommendation:** state in the SDK README and in any security documentation that the injected dialog is a convenience UI, **not** a consent boundary, and that the authoritative confirmation is the desktop app / phone. Never move a security-relevant decision (e.g. "sign without further confirmation", "remember this choice") into it. Using `mode: "closed"` would raise the bar slightly but is not a real defence — the page can still remove or replace the element.

---

### F8 — Page-supplied XSLT/XSD are forwarded unbound to the declared form identifier — **Medium**

`autogram-extension/src/dbridge_js/ditecx/filetype-strategy/xml-bp-strategy.ts:22-45`, `sign-request.ts:82-88`, `dsig-xades-bp-adapter.ts:8-48`

`addXmlObject(...)` accepts, from the page, in one call: the XML to be signed (`xdcXMLData`), the schema (`xdcUsedXSD`), **the XSLT that renders it for the user** (`xdcUsedXSLT`), and the form identifier (`xdcIdentifier`). All are passed straight through to the signer:

```ts
get objTransformation(): string { return this.obj.xdcUsedXSLT; }
get identifier() { return this.obj.xdcIdentifier + "/" + this.obj.xdcVersion; }
```

Nothing validates that the supplied XSLT is the one that legitimately belongs to that identifier. A page that controls both the data and its presentation transform controls what the user *sees* independently of what they *sign* — the classic WYSIWYS break for eForm signing.

**This is the D.Signer model, and the check belongs in the signer**, which is expected to resolve the identifier against the registered eForm and either use the registered XSD/XSLT or verify the supplied ones. I could not verify that the Autogram desktop app or AVM does this — it is outside this repo. But this repo is where the page's values enter the pipeline, and it neither validates nor flags them.

**Recommendation:** confirm with the Autogram desktop/AVM teams that identifier→XSD/XSLT binding is enforced signer-side, and record the answer as an explicit documented assumption of this codebase. If it is not enforced, this becomes the highest-severity issue in the system and needs a fix on the signer side. Consider adding a client-side sanity check (identifier present, XSLT well-formed, no external entity references) as defence in depth.

---

### F9 — Google Fonts injected into every government page and the options page — **Medium** (privacy)

`autogram-sdk/src/injected-ui/main.ts:326-350`, `autogram-extension/src/static/options.html:8`

`addFonts()` runs from `connectedCallback` — i.e. whenever the UI element is created, on every supported portal — and appends three `<link>` elements to the **host page's** `<head>`, pointing at `fonts.googleapis.com` and `fonts.gstatic.com`. The options page independently does `@import url("https://fonts.googleapis.com/...")`.

**Impact:** the extension causes citizens' browsers to contact Google while they are on `slovensko.sk`, `financnasprava.sk` and similar. Google receives IP, User-Agent and `Referer`. Neither the user nor the portal opted into this, and for a government-facing tool distributed by a civic-tech organisation this is a meaningful privacy and (plausibly) GDPR concern. It also fails on portals with a strict `style-src` CSP, and the TODO on line 328 shows this was already known.

**Recommendation:** bundle the WOFF2 files as extension resources (or as `data:` URIs in the Lit stylesheet) and drop the remote links entirely. Same for the options page.

---

### F10 — Unused `isomorphic-webcrypto` and browserify polyfills enlarge the shipped supply chain — **Medium**

`autogram-extension/package.json:95`, `webpack/webpack.common.ts:115-121`

`isomorphic-webcrypto` is declared as a **runtime** dependency of the extension and is **never imported anywhere in the source** (verified by grep across all `.ts`). It is unmaintained (last release 2021) and pulls in `msrcrypto` — a pure-JavaScript crypto implementation — plus the React Native tooling tree that accounts for most of the `npm audit` noise below.

Separately, the webpack `resolve.fallback` maps `crypto → crypto-browserify`, `vm → vm-browserify`, `stream → stream-browserify`. The `vm` shim exists to satisfy the `await import("crypto")` fallback in `avm-api/lib/apiClient.ts:230` — a Node-only path that is dead in a browser extension, since `globalThis.crypto.subtle` is always present and returns first. `vm-browserify` implements `runInNewContext` via a generated iframe and is exactly the shape of code that MV3 remote-code and store review policies target.

**Impact (T7):** every package in a shipped extension's dependency closure is a path to the signing UI of a legally binding signature tool. Unused crypto libraries and `eval`-adjacent shims are pure liability.

**Recommendation:** remove `isomorphic-webcrypto`. Guard the Node `crypto` import behind a build flag or drop it, then remove the `crypto`/`vm`/`stream` fallbacks. Re-verify the bundle afterwards. Consider `npm ci --ignore-scripts` plus lockfile provenance checks in the release pipeline.

---

### F11 — Signing errors are swallowed; the calling page is never told — **Low**

`autogram-extension/src/dbridge_js/autogram/autogram-implementation.ts:198-200`

```ts
} catch (e) {
  log.error(e);
}
```

`getSignature` catches everything — including `UserCancelledSigningException` — and calls neither `callback.onSuccess` nor `callback.onError` (`OnSuccessCallback1` declares an optional `onError` that is never used). The portal's signing flow simply hangs, with no cancellation and no error path. Users get a stuck page rather than "signing cancelled".

A related defect in `avm-api/lib/apiClient.ts:538-551`: the `throw new Error(JSON.stringify(error))` inside the `try` is caught by that same block's own `catch`, so a well-formed API error is always reported as the generic `API Error: <status>` and the server's error detail is discarded.

**Recommendation:** propagate to `callback.onError` where the DITEC API defines one; map `UserCancelledSigningException` to `ERROR_SIGNING_CANCELLED` (already defined in `dsig-base-adapter.ts:32`). Restructure the `getDocument` error branch so parse failure and API error are distinguishable.

---

### F12 — `AbortController` state, alarm listeners and IndexedDB records leak — **Low**

`autogram-extension/src/dbridge_js/autogram/background-worker.ts:249-255, 332-348`

- `browser.alarms.onAlarm.addListener(...)` is registered inside `waitForSignatureSubroutine`, so a new listener accumulates on every signing attempt and is never removed. In an MV3 service worker this compounds across resumes.
- `reset` (line 340-348) deletes the document ref and drops the `AbortController` from the map **without aborting it** — the acknowledged `// TODO: should we abort the request when resetting?`. The polling loop in `AutogramVMobileIntegration.waitForSignature` keeps hitting the server every second for up to 2 hours.
- `set(key, undefined)` is used throughout instead of `del(key)`, leaving tombstone records.

**Recommendation:** register the alarm listener once at worker init and dispatch by name; abort in `reset`; use `del`.

---

### F13 — Selector injection from `localStorage` in the UPVS mobile fixes — **Low**

`autogram-extension/src/upvs-fixes.ts:34-40`

```ts
const lastId = localStorage.getItem("age-lastLoginCardId");
if (lastId) {
  const lastCard = document.querySelector(`#${lastId}`)?.closest(".column-one-half");
```

`lastId` is interpolated into a CSS selector without escaping. It is written from `form.id` on `prihlasenie.slovensko.sk` and `localStorage` is origin-scoped, so this is only reachable by something already executing on that origin. Impact is a thrown `DOMException` or an unintended element match — not code execution. Still worth fixing since this runs on the national login page.

**Recommendation:** use `CSS.escape(lastId)`, or `document.getElementById(lastId)` which needs no escaping.

---

### F14 — Assorted hardening — **Low**

- **Production source maps.** `webpack.prod.ts:163` sets `devtool: "source-map"`, and `manifest.ts` adds every `*.map` to `web_accessible_resources`. The project is open-source so this discloses nothing secret, but it inflates the artifact and makes the exact build trivially fingerprintable. `web-ext build -i '*.map.js'` does not match `*.js.map`, so the maps do ship.
- **Malformed MV2 `web_accessible_resources`.** `manifest.ts` spreads `...enabledUrls` into the MV2 `web_accessible_resources` array (and into `permissions`, where it is correct). WAR entries are extension-relative paths, not URL patterns — `https://www.slovensko.sk/*` as a resource path is meaningless. Harmless today, but it signals the list is not being reasoned about, and MV2 WAR is origin-unrestricted by nature. Prefer the MV3 form with an explicit `matches`.
- **No scheme check before rendering a URL as `href`.** `ZGetQrCodeUrlResponse` is `z.string()`; the value flows into `<a href="${this.url}">` (`sign-mobile.screen.ts:79`, `sign-mobile-on-mobile.screen.ts:26`) and into `window.open` (`with-ui.ts:316`). Not exploitable today because the URL is always built from a hardcoded base — but Lit does not sanitize `href`, so a future refactor that lets the server or page influence this value becomes `javascript:` XSS with no other change. Validate the scheme is `https:` at the boundary.
- **Error reporting is off in production.** `sentry.ts:11, 35` gate everything on `!__IS_PRODUCTION__`, and the DSN points at `localhost:8099`. `captureException` is a silent no-op in shipped builds, so the team has no visibility into failures in a security-critical tool. Whether to add real telemetry is a privacy trade-off worth making deliberately rather than by omission.
- **`waitForSignature` never terminates on a deleted document.** `avm-api/lib/apiClient.ts:201-215` treats every non-`signed` status as "keep polling", including `not found`. A document deleted server-side polls for the full 2 hours.

---

### F15 — Example apps render server-controlled data via `innerHTML` and are publicly deployed — **Low**

`example-avm-integration/src/ui.ts:13-28, 55-71`, `example-extension-usage/src/ui.ts:13-24`

```ts
Object.defineProperty(obj, "j", { set: (value) => { el.innerHTML = JSON.stringify(value, null, 2); } });
```

`$("signedMetadata").j = …` and friends render AVM server responses — including `signers[].signedBy` / `issuedBy`, which originate from certificate contents — straight into `innerHTML`. `showSignedPreview` builds `img.src` and `iframe.src` `data:` URLs from an unvalidated `mimeType`.

Two reasons this matters despite being demo code: `.github/workflows/deploy-example-avm-integration.yml` publishes it to GitHub Pages on every push to `master`, and example code is what integrators copy.

**Recommendation:** use `textContent` for the JSON dump, allowlist `mimeType` against the set actually handled, and add a short "this is demo code, not a security reference" note to the example READMEs.

---

### F16 — npm advisories — **Informational**

`npm audit` reports 110 advisories (10 critical, 41 high). Every one traced is in **development and build tooling** — `webpack-dev-server`, `web-ext`, the React Native tree pulled in by `isomorphic-webcrypto` (F10), `xcode`, `yaml`, `ws`. None are in code that ships to users' browsers.

They are not user-facing risk, but they are build-machine and CI risk (T7): a compromised build dependency can modify the extension that gets signed and published. Fixing F10 removes a large share of the tree outright.

**Recommendation:** `npm audit fix` for the non-breaking set; schedule the `web-ext@10` major upgrade; consider pinning and reviewing build-time dependencies more strictly than runtime ones, since they run with developer privileges.

---

## 3. What the code does well

Worth recording, because these are the controls the rest of the system rests on:

- **The site allowlist is tight.** Explicit HTTPS origins, no wildcards, no `<all_urls>`, and debug origins correctly compiled out of production builds (`supported-sites.ts:129-148`).
- **`externally_connectable` is disabled.** Arbitrary websites cannot reach the background worker. This is the single control that keeps T1 out.
- **Extension permissions are minimal** — `storage` and `alarms` in MV3. No `tabs`, no `webRequest`, no `scripting`.
- **Message payloads are schema-validated.** `ZChannelMessage`, `ZAutogramDocument`, `ZSignatureParameters` and the AVM response schemas give a real, enumerated boundary at the content-script → worker hop. The signature-parameter enums in particular are tight.
- **The UI framework choice is right.** Lit auto-escapes interpolations; `unsafeSVG` is confined to constants and generated QR output. No DOM XSS was found in the SDK UI.
- **The dialog does not display the document.** Consent for *content* is deferred to the desktop app / phone, which are far better positioned to provide it. This is the correct architecture and should be defended against future "convenience" changes.
- **No telemetry in production builds** and no hardcoded secrets anywhere in the tree.
- **The authors already flag most of the state-management problems** in TODO comments. The findings above largely agree with the team's own reading; what they add is the security consequence and a ranking.

---

## 4. Prioritised remediation

**Now — closes the cross-origin gaps (F2, F3, F5)**
1. Read `port.sender.url` in the background worker; derive an origin and reject senders that do not match `supportedSites`.
2. Re-key `dbKeyDocumentRef` and `dbKeyRestorePoint` on origin. Store the document ref (not the key string) in restore points; restore the TTL/cleanup. Use `del()`.
3. Constrain `ChannelMessage.method` to a `z.enum` and use own-property dispatch.

**Now — closes F4**
4. `extractable: false` on the ES256 integration key. Document the SDK-path key-storage caveat in the README.

**Next — F1 and the API-contract problem**
5. Stop sending `origin=*`; pass the real origin from the worker and `location.origin` from the SDK.
6. Decide on the HMAC: implement it, or remove `secretKey`/`secretInitialNonce`/`disableSecurity` from the public API and docs. Do not leave an inert security parameter documented as active.

**Next — F9, F10**
7. Bundle the fonts; remove the remote `<link>`s and the options-page `@import`.
8. Drop `isomorphic-webcrypto` and the `crypto`/`vm`/`stream` webpack fallbacks; re-verify the bundle.

**Then**
9. Confirm signer-side identifier→XSD/XSLT binding with the Autogram desktop/AVM teams and record it as a documented assumption (F8).
10. Fix error propagation (F11), the leaks (F12), `CSS.escape` (F13), the F14 hardening set, and the examples (F15).
11. `npm audit fix`; plan the `web-ext` major upgrade (F16).

**Documentation to add**
- A `SECURITY.md` stating the trust model plainly: the injected dialog is not a consent boundary; the desktop app / phone is the authoritative confirmation; the AVM server sees plaintext documents and their keys; direct SDK use places the integration identity in the integrating site's origin.

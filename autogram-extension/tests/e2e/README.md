# Extension e2e tests (Playwright)

Load the built extension into Chromium and drive the **live** portals —
the layer above the jest portal contract tests
(`src/dbridge_js/ditecx/portal-*.test.ts`), which replay portal driver
scripts but cannot see injection-level failures (content script timing,
`window.ditec` replacement races, the RPC bridge, the signing UI).

## Prerequisites

```sh
npm run vite:build-dev        # builds dist/ (MV3), loaded into Chromium
npx playwright install chromium
```

- Network access to the portals (the tests drive the real pages).
- The real Autogram desktop app must **not** be running: the tests bind
  its port (37200) with a fake (`fake-autogram-desktop.ts`) that answers
  `GET /info` / `POST /sign`, so signing completes without an eID.

Run with `npm run test:e2e` (rebuilds dist first) or `npx playwright
test` directly.

Environment:

- `HTTPS_PROXY` — passed on to Chromium (which ignores the variable by
  itself), so the suite also runs behind a proxy.
- `AE_E2E_CHROMIUM_PATH` — use this Chromium binary instead of the one
  `playwright install` downloads.

The suite depends on third-party production sites, so it is not part of
the PR checks; `.github/workflows/live-portals.yml` runs it nightly (and
on demand) together with the checksum drift check.

## Three ways to reach a portal without logging in

1. **Real page, real flow** (`justice-live-portal.spec.ts`) — the portal
   has an anonymous signing page; the test drives it like a user and
   intercepts the final upload.
2. **Real page, portal's own driver** (`nove-composer-live-portal.spec.ts`)
   — the signing UI is behind a login, but an anonymous page of the same
   app still loads the whole signing stack; the test calls the page's own
   `DSigner` the way the app would.
3. **Harness on the real origin** (`schranka-live-driver.spec.ts`) — no
   anonymous page loads the signer, so the test serves one small document
   on the portal's origin that loads the portal's live scripts. Use this
   pattern for other login-only portals whose signer scripts are publicly
   downloadable (`portal-driver.ts` has the shared helpers).

Authenticated end-to-end runs (a real mailbox, a real submission) are
deliberately out of scope: they need an eID and leave traces in
production systems.

## What is (and isn't) real

Everything runs for real — the portal page and its D.Bridge scripts, the
extension's content script → inject bundle → `window.ditec` replacement,
the signing dialog, the background worker RPC — except:

- the Autogram desktop app is the local fake on port 37200;
- the final POST of the signed document back to the portal is
  intercepted by `context.route`, so the fake signature never reaches
  the portal's servers.

## Tests

| Spec                                | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `justice-live-portal.spec.ts`       | <https://obcan.justice.sk/podpisovanie-dokumentov> (login-free): uploads a PDF and signs **twice in a row** — the regression from [issue #101](https://github.com/slovensko-digital/autogram-extension/issues/101#issuecomment-4978486015), where signing fell back to D.Launcher. Root cause found by this test: the inject bundle can run before the parser creates `<body>`; `CombinedClient` UI setup crashed on `document.body.appendChild`, the rejection was swallowed in `inject-ditec.ts`, and `window.ditec` was never replaced. Fixed by `waitForDocumentBody()` (autogram-sdk `with-ui.ts`) + error logging in the conflict resolvers. |
| `nove-composer-live-portal.spec.ts` | <https://message-constructor-web.slovensko.sk> (nove.slovensko.sk composer, anonymous `/error` route): `window.ditec` replacement next to the live D.Bridge, the `signer-type` pin, and the page's live `DSigner.sign()` signing an XML data container through the dialog → background worker → desktop app, plus cancel-then-retry.                                                                                                                                                                                                                                                                                                               |
| `schranka-live-driver.spec.ts`      | schranka.slovensko.sk's live D.Bridge + `DSignerMulti.js` on a harness document served at the portal's origin: content-script match, on-load injection, replace-original, ASiC signing and the multi-document error reaching the portal's error dialog.                                                                                                                                                                                                                                                                                                                                                                                            |
| `supported-sites-smoke.spec.ts`     | Public landing pages of slovensko.sk, financnasprava.sk, cep.financnasprava.sk and sluzby.orsr.sk: the inject bundle loads (no CSP/extension errors) and a page without D.Signer is left untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `popup.spec.ts`                     | Toolbar popup → options page. Offline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

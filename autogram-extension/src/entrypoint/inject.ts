import { setLogLevel } from "autogram-sdk";
import { inject } from "../dbridge_js/inject-ditec";
import { rememberExtensionBaseUrl } from "../dbridge_js/autogram/extension-pages";
import { createLogger } from "../log";
import {
  defaultOptionsStorage,
  ExtensionOptions,
  ExtensionOptionsString,
} from "../options/default";
import { captureException } from "../sentry";
import { maybeInsertUpvsJsFixes } from "../upvs-fixes";

const log = createLogger("ag-ext.ent.inject");
// must run while the bundle evaluates (document.currentScript)
rememberExtensionBaseUrl(document.currentScript);
// the SDK is quiet by default; development builds get its debug output
if (!__IS_PRODUCTION__) {
  setLogLevel("debug");
}
try {
  const windowAny = window as WindowWithDitec;

  const extensionOptionsPromise = new Promise<ExtensionOptions>((resolve) => {
    const handleEvent = (event: CustomEvent<ExtensionOptionsString>) => {
      resolve(JSON.parse(event.detail) as ExtensionOptions);
      window.removeEventListener("autogram-extension-options", handleEvent);
    };
    window.addEventListener("autogram-extension-options", handleEvent);
  });

  Promise.race([
    extensionOptionsPromise,
    new Promise<ExtensionOptions>((res) =>
      setTimeout(() => res(defaultOptionsStorage.options), 200)
    ),
  ]).then((extensionOptions) => {
    maybeInsertUpvsJsFixes(windowAny);
    inject(windowAny, extensionOptions);
  });
} catch (e) {
  log.error("Error during inject", e);
  captureException(e);
}

type WindowWithDitec = Window & { ditec?: object };

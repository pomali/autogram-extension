import type { AutogramVMobileIntegration } from "autogram-sdk";

/**
 * Creates-side hook for every `AutogramVMobileIntegration` the extension
 * makes (background worker, options page): applies the build-time server
 * override, if any. Release builds cannot have one (the build script
 * refuses it), so they always use the SDK's official server.
 */
export function withConfiguredAvmServer(
  integration: AutogramVMobileIntegration
): AutogramVMobileIntegration {
  const baseUrl =
    typeof __AVM_BASE_URL__ !== "undefined" ? __AVM_BASE_URL__ : "";
  if (baseUrl) {
    integration.setBaseUrl(baseUrl);
  }
  return integration;
}

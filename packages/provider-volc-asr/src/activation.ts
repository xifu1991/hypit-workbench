import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigBoolean,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-kit";

import { readVolcConfig } from "./config.js";
import { createVolcAsrProvider } from "./provider.js";

const volcRuntimeAdapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-volc-asr",
  async activate(context) {
    if (context.pool === undefined) throw new Error("Volc ASR Provider Pool is required");
    const config = runtimeConfigObject(context.config, "Volc ASR");
    runtimeConfigExact(config, [
      "configPath",
      "defaultConcurrency",
      "requestTimeoutMs",
      "maxResponseBytes",
      "deleteTemporaryObject",
      "temporaryObjectPrefix",
      "presignExpiresSeconds",
    ], "Volc ASR");
    const configPath = runtimeConfigString(config.configPath, "Volc ASR configPath");
    const defaultConcurrency = runtimeConfigPositiveInteger(
      config.defaultConcurrency,
      "Volc ASR defaultConcurrency",
    );
    const requestTimeoutMs = runtimeConfigPositiveInteger(
      config.requestTimeoutMs,
      "Volc ASR requestTimeoutMs",
    );
    const maxResponseBytes = runtimeConfigPositiveInteger(
      config.maxResponseBytes,
      "Volc ASR maxResponseBytes",
    );
    const deleteTemporaryObject = runtimeConfigBoolean(
      config.deleteTemporaryObject,
      "Volc ASR deleteTemporaryObject",
    );
    const temporaryObjectPrefix = runtimeConfigString(
      config.temporaryObjectPrefix,
      "Volc ASR temporaryObjectPrefix",
    );
    const presignExpiresSeconds = runtimeConfigPositiveInteger(
      config.presignExpiresSeconds,
      "Volc ASR presignExpiresSeconds",
    );
    const loaded = await readVolcConfig(configPath);
    return {
      endpoint: createVolcAsrProvider({
        instance: context.instance,
        pool: context.pool,
        config: loaded,
        ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
        ...(deleteTemporaryObject === undefined ? {} : { deleteTemporaryObject }),
        ...(temporaryObjectPrefix === undefined ? {} : { temporaryObjectPrefix }),
        ...(presignExpiresSeconds === undefined ? {} : { presignExpiresSeconds }),
      }),
      diagnose: () => [{
        severity: "info",
        code: loaded.gateway === undefined ? "VOLC_ASR_CONFIGURED" : "HYPIT_GATEWAY_ASR_CONFIGURED",
        message: loaded.gateway === undefined
          ? `Doubao ASR ${loaded.asr.resourceId} is configured from ${loaded.path}`
          : `Doubao ASR is configured through the Hypit gateway at ${loaded.gateway.url}`,
        subject: context.instance,
      }],
    };
  },
});

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  hostFacets: [volcRuntimeAdapter],
};

export default hypitPackage;

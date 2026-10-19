import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type VolcAsrServiceConfig = {
  readonly endpoint: string;
  readonly resourceId: string;
  readonly apiKey?: string;
  readonly appId?: string;
  readonly accessToken?: string;
  readonly enableSpeaker: boolean;
};

export type VolcObjectStorageConfig = {
  readonly accessKey: string;
  readonly secretKey: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
};

export type HypitGatewayConfig = {
  readonly url: string;
  readonly token: string;
};

export type VolcConfig = {
  readonly path: string;
  readonly asr: VolcAsrServiceConfig;
  readonly tos?: VolcObjectStorageConfig;
  /** When present, transcription goes through the tenant gateway without local Volc credentials. */
  readonly gateway?: HypitGatewayConfig;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, subject: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  assert(typeof value === "string", `${subject} must be a string`);
  const result = value.trim();
  return result.length === 0 ? undefined : result;
}

function requiredString(value: unknown, subject: string): string {
  const result = optionalString(value, subject);
  assert(result !== undefined, `${subject} is required`);
  return result;
}

function expandEnvironment(value: unknown): unknown {
  if (typeof value === "string") {
    const match = /^\$\{([A-Z0-9_]+)\}$/u.exec(value);
    return match === null ? value : process.env[match[1]!] ?? "";
  }
  if (Array.isArray(value)) return value.map(expandEnvironment);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandEnvironment(item)]));
  }
  return value;
}

function endpoint(value: unknown, subject: string): string {
  const result = requiredString(value, subject);
  const url = new URL(result.includes("://") ? result : `https://${result}`);
  assert(url.protocol === "https:" || url.protocol === "http:", `${subject} must be an HTTP(S) endpoint`);
  return result.replace(/\/+$/u, "");
}

function gatewayConfig(value: unknown): HypitGatewayConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const gateway = object(value, "hypit_gateway");
  assert(gateway.enabled === undefined || typeof gateway.enabled === "boolean",
    "hypit_gateway.enabled must be boolean");
  if (gateway.enabled !== true) return undefined;
  return {
    url: endpoint(gateway.url, "hypit_gateway.url"),
    token: requiredString(gateway.token, "hypit_gateway.token"),
  };
}

/** Read only the caller's explicit file or VOLC_ASR_CONFIG; never search other users' history. */
export async function readVolcConfig(path?: string): Promise<VolcConfig> {
  const selected = resolve(path ?? process.env.VOLC_ASR_CONFIG ?? "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(selected, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read Volc ASR config at ${selected}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = object(expandEnvironment(raw), "Volc ASR config");
  const gateway = gatewayConfig(root.hypit_gateway);
  if (gateway !== undefined) {
    return {
      path: selected,
      gateway,
      asr: {
        endpoint: gateway.url,
        resourceId: "hypit-gateway",
        enableSpeaker: true,
      },
    };
  }
  const asr = object(root.volc_asr, "volc_asr");
  const tos = object(root.volc_tos, "volc_tos");

  const apiKey = optionalString(asr.api_key, "volc_asr.api_key");
  const appId = optionalString(asr.app_id, "volc_asr.app_id");
  const accessToken = optionalString(asr.access_token, "volc_asr.access_token");
  assert(apiKey !== undefined || (appId !== undefined && accessToken !== undefined),
    "volc_asr requires api_key or both app_id and access_token");
  assert(!(apiKey !== undefined && (appId !== undefined || accessToken !== undefined)),
    "volc_asr must use either api_key or app_id/access_token, not both");
  const enableSpeaker = asr.enable_speaker;
  assert(enableSpeaker === undefined || typeof enableSpeaker === "boolean", "volc_asr.enable_speaker must be boolean");

  return {
    path: selected,
    asr: {
      endpoint: endpoint(asr.endpoint ?? "https://openspeech.bytedance.com", "volc_asr.endpoint"),
      resourceId: requiredString(asr.resource_id ?? "volc.seedasr.auc", "volc_asr.resource_id"),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(appId === undefined ? {} : { appId }),
      ...(accessToken === undefined ? {} : { accessToken }),
      enableSpeaker: enableSpeaker ?? true,
    },
    tos: {
      accessKey: requiredString(tos.access_key, "volc_tos.access_key"),
      secretKey: requiredString(tos.secret_key, "volc_tos.secret_key"),
      endpoint: endpoint(tos.endpoint, "volc_tos.endpoint"),
      region: requiredString(tos.region, "volc_tos.region"),
      bucket: requiredString(tos.bucket, "volc_tos.bucket"),
    },
  };
}

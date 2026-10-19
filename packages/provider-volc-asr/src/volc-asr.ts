import { createHash } from "node:crypto";

import type { VolcConfig, VolcObjectStorageConfig } from "./config.js";
import { signTosUrl } from "./tos.js";

type ReportProgress = (phase: string) => Promise<void> | void;
type ReportDiagnostic = (level: "info" | "warning" | "error", message: string) => Promise<void> | void;

export type TranscribeVolcOptions = {
  readonly config: VolcConfig;
  readonly audio: Uint8Array;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly deleteTemporaryObject: boolean;
  readonly temporaryObjectPrefix: string;
  readonly presignExpiresSeconds: number;
  readonly reportProgress?: ReportProgress;
  readonly reportDiagnostic?: ReportDiagnostic;
};

type JsonPostResult = {
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function limitedBytes(response: Response, maxBytes: number, subject: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.byteLength <= maxBytes, `${subject} exceeded the configured response limit`);
  return bytes;
}

async function jsonPost(
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Record<string, unknown>,
  timeoutMs: number,
  maxResponseBytes: number,
  subject: string,
): Promise<JsonPostResult> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = await limitedBytes(response, maxResponseBytes, subject);
  const text = new TextDecoder().decode(bytes);
  if (!response.ok) {
    throw new Error(`${subject} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const parsed = text.trim().length === 0 ? {} : JSON.parse(text) as unknown;
  assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
    `${subject} returned an invalid JSON object`);
  return { body: parsed as Record<string, unknown>, headers: response.headers };
}

function asrHeaders(config: VolcConfig["asr"], requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  };
  if (config.apiKey !== undefined) {
    headers["X-Api-Key"] = config.apiKey;
  } else {
    headers["X-Api-App-Key"] = config.appId!;
    headers["X-Api-Access-Key"] = config.accessToken!;
  }
  return headers;
}

function statusCode(headers: Headers): string | undefined {
  return headers.get("x-api-status-code") ?? headers.get("X-Api-Status-Code") ?? undefined;
}

function statusMessage(headers: Headers): string {
  return headers.get("x-api-message") ?? headers.get("X-Api-Message") ?? "unknown error";
}

function objectName(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/gu, "");
  return `${normalized.length === 0 ? "hypit-volc-asr" : normalized}/${crypto.randomUUID()}.wav`;
}

async function putObject(
  options: TranscribeVolcOptions,
  tos: VolcObjectStorageConfig,
  key: string,
): Promise<string> {
  const url = signTosUrl({
    method: "PUT",
    endpoint: tos.endpoint,
    region: tos.region,
    bucket: tos.bucket,
    key,
    accessKey: tos.accessKey,
    secretKey: tos.secretKey,
    expiresSeconds: options.presignExpiresSeconds,
  });
  await options.reportProgress?.("Uploading speech evidence to Volc TOS");
  const body = new ArrayBuffer(options.audio.byteLength);
  new Uint8Array(body).set(options.audio);
  const response = await fetch(url, {
    method: "PUT",
    body,
    signal: AbortSignal.timeout(options.requestTimeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Volc TOS upload failed with HTTP ${response.status}: ${detail}`);
  }
  return signTosUrl({
    method: "GET",
    endpoint: tos.endpoint,
    region: tos.region,
    bucket: tos.bucket,
    key,
    accessKey: tos.accessKey,
    secretKey: tos.secretKey,
    expiresSeconds: options.presignExpiresSeconds,
  });
}

async function deleteObject(
  options: TranscribeVolcOptions,
  tos: VolcObjectStorageConfig,
  key: string,
): Promise<void> {
  const url = signTosUrl({
    method: "DELETE",
    endpoint: tos.endpoint,
    region: tos.region,
    bucket: tos.bucket,
    key,
    accessKey: tos.accessKey,
    secretKey: tos.secretKey,
    expiresSeconds: options.presignExpiresSeconds,
  });
  const response = await fetch(url, {
    method: "DELETE",
    signal: AbortSignal.timeout(options.requestTimeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

function gatewayErrorDetail(body: string): { readonly code?: string; readonly message?: string } {
  const text = body.trim();
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        ...(record.code === undefined ? {} : { code: String(record.code) }),
        ...(record.message === undefined ? {} : { message: String(record.message) }),
      };
    }
  } catch {
    // A proxy may answer with plain text instead of the gateway's JSON envelope.
  }
  return { message: text.split(/\r?\n/u)[0]!.slice(0, 400) };
}

async function transcribeThroughGateway(options: TranscribeVolcOptions): Promise<Record<string, unknown>> {
  const gateway = options.config.gateway!;
  const digest = createHash("sha256").update(options.audio).digest("hex");
  const baseKey = `doubao-asr:${digest}`;
  let key = baseKey;

  await options.reportProgress?.("Submitting speech to the Hypit gateway");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = new ArrayBuffer(options.audio.byteLength);
    new Uint8Array(body).set(options.audio);
    const response = await fetch(`${gateway.url}/gateway/v1/asr`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${gateway.token}`,
        "Content-Type": "audio/wav",
        "Idempotency-Key": key,
      },
      body,
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    const bytes = await limitedBytes(response, options.maxResponseBytes, "Hypit gateway ASR");
    const text = new TextDecoder().decode(bytes);
    if (!response.ok) {
      const detail = gatewayErrorDetail(text);
      if (attempt === 0 && detail.code === "previous_request_failed") {
        key = `${baseKey}:retry:${crypto.randomUUID()}`;
        continue;
      }
      const code = detail.code === undefined ? "" : ` code=${detail.code}`;
      const message = detail.message === undefined ? "no response body" : detail.message;
      throw new Error(`Hypit gateway transcription failed with HTTP ${response.status}${code}: ${message}`);
    }
    const parsed = text.trim().length === 0 ? {} : JSON.parse(text) as unknown;
    assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
      "Hypit gateway ASR returned an invalid JSON object");
    const envelope = parsed as Record<string, unknown>;
    const result = envelope.result;
    assert(result !== null && typeof result === "object" && !Array.isArray(result),
      "Hypit gateway ASR response has no result object");
    await options.reportProgress?.("Doubao transcription completed through Hypit");
    return result as Record<string, unknown>;
  }
  throw new Error("Hypit gateway ASR retry loop ended unexpectedly");
}

async function transcribeVolcDirect(
  options: TranscribeVolcOptions,
  tos: VolcObjectStorageConfig,
): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID();
  const key = objectName(options.temporaryObjectPrefix);
  let uploaded = false;
  try {
    const audioUrl = await putObject(options, tos, key);
    uploaded = true;
    await options.reportProgress?.("Submitting Doubao recording-file transcription");

    const headers = asrHeaders(options.config.asr, requestId);
    const submit = await jsonPost(
      `${options.config.asr.endpoint}/api/v3/auc/bigmodel/submit`,
      headers,
      {
        user: { uid: requestId },
        audio: { url: audioUrl, format: "wav", rate: 16_000, bits: 16, channel: 1 },
        request: {
          model_name: "bigmodel",
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
          enable_speaker_info: options.config.asr.enableSpeaker,
          show_utterances: true,
        },
      },
      options.requestTimeoutMs,
      options.maxResponseBytes,
      "Doubao ASR submit",
    );
    const submitStatus = statusCode(submit.headers);
    if (submitStatus !== undefined && submitStatus !== "0" && submitStatus !== "20000000") {
      throw new Error(`Doubao ASR submit failed status=${submitStatus} msg=${statusMessage(submit.headers)}`);
    }

    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await options.reportProgress?.("Waiting for Doubao transcription");
      const query = await jsonPost(
        `${options.config.asr.endpoint}/api/v3/auc/bigmodel/query`,
        asrHeaders(options.config.asr, requestId),
        {},
        options.requestTimeoutMs,
        options.maxResponseBytes,
        "Doubao ASR query",
      );
      const queryStatus = statusCode(query.headers);
      const result = query.body.result;
      if ((queryStatus === "0" || queryStatus === "20000000")
        && (result !== undefined || Array.isArray(query.body.utterances))) {
        return query.body;
      }
      if (queryStatus !== undefined
        && queryStatus !== "0"
        && queryStatus !== "20000000"
        && queryStatus !== "20000001"
        && queryStatus !== "20000002") {
        throw new Error(`Doubao ASR query failed status=${queryStatus} msg=${statusMessage(query.headers)}`);
      }
    }
    throw new Error("Doubao ASR polling timed out");
  } finally {
    if (uploaded && options.deleteTemporaryObject) {
      try {
        await deleteObject(options, tos, key);
      } catch (error) {
        await options.reportDiagnostic?.(
          "warning",
          `Temporary TOS object cleanup failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

export async function transcribeVolc(options: TranscribeVolcOptions): Promise<Record<string, unknown>> {
  if (options.config.gateway !== undefined) return transcribeThroughGateway(options);
  assert(options.config.tos !== undefined,
    "volc_tos is required when the Hypit gateway is disabled");
  return transcribeVolcDirect(options, options.config.tos);
}

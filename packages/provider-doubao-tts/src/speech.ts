import { createHash } from "node:crypto";

import type { DoubaoSpeechAudioFormat, DoubaoSpeechConfig } from "./config.js";
import { doubaoSpeechAudioFormats, resolveDoubaoSpeaker } from "./config.js";

export type DoubaoSpeechProgress = (phase: string) => Promise<void> | void;

export type SynthesizeDoubaoSpeechOptions = {
  readonly config: DoubaoSpeechConfig;
  readonly text: string;
  /**
   * The voice for this request: a name from `config.speakers`, or a literal console speaker id.
   * Omitted, the config's default voice speaks. Dialogue resolves one voice per line.
   */
  readonly speaker?: string;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly reportProgress?: DoubaoSpeechProgress;
};

export type DoubaoSpeechSynthesis = {
  readonly audio: Uint8Array;
  readonly format: DoubaoSpeechAudioFormat;
  readonly requestId: string;
  readonly logId?: string;
  readonly usage?: Record<string, unknown>;
  /** Number of stream messages that carried audio; a diagnostic, not a contract. */
  readonly audioMessages: number;
};

export type DoubaoSpeechFailure = {
  readonly code?: string;
  readonly message?: string;
  readonly httpStatus?: number;
  readonly logId?: string;
  readonly resourceId: string;
  readonly speaker: string;
};

const failureHints: Readonly<Record<string, string>> = {
  "45000010": "The API key was rejected. Use a key created for the Doubao speech service on the account that owns the voice.",
  "45000030": "The account has not activated the product this resource id bills to. Enable the matching synthesis product in the Doubao speech console for the account that owns the voice, then confirm the voice itself is active.",
  "55000000": "The resource id does not match the resource that owns this voice. Query the voice to see which product it belongs to.",
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Report the service's own code and message, then one sentence naming the fix. A bare
 * "HTTP 403" is what makes this class of account failure expensive to diagnose.
 */
export function describeDoubaoSpeechFailure(failure: DoubaoSpeechFailure): string {
  const status = failure.httpStatus === undefined ? "" : ` with HTTP ${failure.httpStatus}`;
  const code = failure.code === undefined ? "" : ` code=${failure.code}`;
  const logId = failure.logId === undefined ? "" : ` logid=${failure.logId}`;
  const detail = failure.message === undefined ? "" : `: ${failure.message}`;
  const hint = failure.code === undefined ? undefined : failureHints[failure.code];
  const advice = hint === undefined
    ? ""
    : ` Speaker ${failure.speaker} on resource ${failure.resourceId}: ${hint}`;
  return `Doubao speech synthesis failed${status}${code}${logId}${detail}.${advice}`;
}

function requestHeaders(config: DoubaoSpeechConfig, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connection": "keep-alive",
    "X-Api-Resource-Id": config.resourceId,
    "X-Api-Request-Id": requestId,
    "X-Control-Require-Usage-Tokens-Return": "*",
  };
  if (config.apiKey !== undefined) {
    headers["X-Api-Key"] = config.apiKey;
  } else {
    headers["X-Api-App-Key"] = config.appId!;
    headers["X-Api-Access-Key"] = config.accessToken!;
  }
  return headers;
}

export function doubaoSpeechRequestBody(
  config: DoubaoSpeechConfig,
  text: string,
  speaker: string = config.speaker,
): Record<string, unknown> {
  return {
    req_params: {
      text,
      speaker,
      audio_params: {
        format: config.format,
        sample_rate: config.sampleRate,
        ...(config.speechRate === undefined ? {} : { speech_rate: config.speechRate }),
        ...(config.loudnessRate === undefined ? {} : { loudness_rate: config.loudnessRate }),
      },
    },
  };
}

function parseFailureDetail(body: string): { readonly code?: string; readonly message?: string } {
  const trimmed = body.trim();
  if (trimmed.length > 0) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const header = record.header;
        const source = header !== null && typeof header === "object" && !Array.isArray(header)
          ? header as Record<string, unknown>
          : record;
        const code = source.code ?? record.code;
        const message = source.message ?? record.message;
        return {
          ...(code === undefined ? {} : { code: String(code) }),
          ...(message === undefined ? {} : { message: String(message) }),
        };
      }
    } catch {
      // A failure may arrive as plain text; the first line still helps.
    }
    return { message: trimmed.split(/\r?\n/u)[0]!.slice(0, 400) };
  }
  return {};
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
    // The gateway may be behind a reverse proxy that returned plain text.
  }
  return { message: text.split(/\r?\n/u)[0]!.slice(0, 400) };
}

function gatewayIdempotencyKey(text: string, speaker: string | undefined): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ text, speaker: speaker ?? "" }), "utf8")
    .digest("hex");
  return `doubao-tts:${digest}`;
}

function gatewayAudioFormat(value: string | null): DoubaoSpeechAudioFormat {
  if (value === null || value.length === 0) return "wav";
  assert((doubaoSpeechAudioFormats as readonly string[]).includes(value),
    `Hypit gateway returned unsupported audio format ${value}`);
  return value as DoubaoSpeechAudioFormat;
}

async function synthesizeThroughGateway(
  options: SynthesizeDoubaoSpeechOptions,
  text: string,
): Promise<DoubaoSpeechSynthesis> {
  const gateway = options.config.gateway!;
  const speaker = options.speaker?.trim().length ? options.speaker.trim() : gateway.speaker;
  const maxBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  const baseKey = gatewayIdempotencyKey(text, speaker);
  let key = baseKey;

  await options.reportProgress?.(
    `Synthesizing ${text.length} characters through the Hypit gateway${speaker === undefined ? "" : ` with voice ${speaker}`}`,
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${gateway.url}/gateway/v1/tts`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${gateway.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        text,
        ...(speaker === undefined ? {} : { speaker }),
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 5 * 60_000),
    });

    if (!response.ok) {
      const detail = gatewayErrorDetail(await response.text());
      if (attempt === 0 && detail.code === "previous_request_failed") {
        key = `${baseKey}:retry:${crypto.randomUUID()}`;
        continue;
      }
      const code = detail.code === undefined ? "" : ` code=${detail.code}`;
      const message = detail.message === undefined ? "no response body" : detail.message;
      throw new Error(`Hypit gateway speech synthesis failed with HTTP ${response.status}${code}: ${message}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    assert(bytes.byteLength > 0, "Hypit gateway speech synthesis returned no audio");
    assert(bytes.byteLength <= maxBytes, "Hypit gateway speech synthesis exceeded the configured response limit");
    const taskId = response.headers.get("x-hypit-task-id");
    const format = gatewayAudioFormat(response.headers.get("x-hypit-format"));
    const costFen = Number(response.headers.get("x-hypit-cost-fen") ?? 0);
    const balanceHeader = response.headers.get("x-hypit-balance-fen");
    const balanceFen = balanceHeader === null || balanceHeader.length === 0 ? null : Number(balanceHeader);
    const replay = response.headers.get("x-hypit-idempotent-replay") === "1";

    return {
      audio: Buffer.from(bytes),
      format,
      requestId: taskId ?? crypto.randomUUID(),
      usage: {
        gateway: true,
        taskId,
        costFen: Number.isFinite(costFen) ? costFen : 0,
        balanceFen: balanceFen !== null && Number.isFinite(balanceFen) ? balanceFen : null,
        replay,
      },
      audioMessages: 1,
    };
  }

  throw new Error("Hypit gateway speech synthesis retry loop ended unexpectedly");
}

export async function synthesizeDoubaoSpeech(
  options: SynthesizeDoubaoSpeechOptions,
): Promise<DoubaoSpeechSynthesis> {
  const text = options.text.trim();
  assert(text.length > 0, "Doubao speech synthesis requires non-empty text");
  if (options.config.gateway !== undefined) return synthesizeThroughGateway(options, text);
  const maxBytes = options.maxResponseBytes ?? 64 * 1024 * 1024;
  const requestId = crypto.randomUUID();
  const { config } = options;
  const speaker = resolveDoubaoSpeaker(config, options.speaker);

  await options.reportProgress?.(`Synthesizing ${text.length} characters with Doubao speaker ${speaker}`);
  const response = await fetch(`${config.endpoint}/api/v3/tts/unidirectional`, {
    method: "POST",
    headers: requestHeaders(config, requestId),
    body: JSON.stringify(doubaoSpeechRequestBody(config, text, speaker)),
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? 5 * 60_000),
  });
  const logId = response.headers.get("x-tt-logid") ?? response.headers.get("X-Tt-Logid") ?? undefined;

  if (!response.ok) {
    const detail = parseFailureDetail(await response.text());
    throw new Error(describeDoubaoSpeechFailure({
      ...detail,
      httpStatus: response.status,
      ...(logId === undefined ? {} : { logId }),
      resourceId: config.resourceId,
      speaker,
    }));
  }

  const body = response.body;
  assert(body !== null, `Doubao speech synthesis returned no response body${logId === undefined ? "" : ` (logid=${logId})`}`);

  const chunks: Uint8Array[] = [];
  let audioMessages = 0;
  let totalBytes = 0;
  let usage: Record<string, unknown> | undefined;
  let failure: { readonly code?: string; readonly message?: string } | undefined;
  let complete = false;
  const decoder = new TextDecoder();
  let pending = "";

  const handle = (line: string): void => {
    if (line.trim().length === 0) return;
    const parsed = JSON.parse(line) as unknown;
    assert(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed),
      "Doubao speech synthesis returned a non-object stream message");
    const message = parsed as Record<string, unknown>;
    const code = message.code === undefined ? undefined : String(message.code);
    if (message.usage !== undefined && message.usage !== null && typeof message.usage === "object" && !Array.isArray(message.usage)) {
      usage = message.usage as Record<string, unknown>;
    }
    if (code !== undefined && code !== "0" && code !== "20000000") {
      failure = { code, ...(message.message === undefined ? {} : { message: String(message.message) }) };
      return;
    }
    if (typeof message.data === "string" && message.data.length > 0) {
      const audio = Buffer.from(message.data, "base64");
      totalBytes += audio.byteLength;
      assert(totalBytes <= maxBytes, "Doubao speech synthesis exceeded the configured response limit");
      chunks.push(audio);
      audioMessages += 1;
    }
    if (code === "20000000") complete = true;
  };

  // Read through an explicit reader: a `ReadableStream` is not typed as async-iterable here, and
  // stopping early has to cancel the response so a failing synthesis releases the connection.
  const reader = body.getReader();
  let drained = false;
  try {
    while (!complete && failure === undefined) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        handle(line);
        if (failure !== undefined || complete) break;
      }
    }
  } finally {
    // Leaving a half-read synthesis open holds a connection the account is billed for.
    if (!drained) await reader.cancel().catch(() => undefined);
  }
  if (failure === undefined && !complete && pending.trim().length > 0) handle(pending);

  if (failure !== undefined) {
    throw new Error(describeDoubaoSpeechFailure({
      ...failure,
      httpStatus: response.status,
      ...(logId === undefined ? {} : { logId }),
      resourceId: config.resourceId,
      speaker,
    }));
  }

  const audio = Buffer.concat(chunks);
  assert(audio.byteLength > 0,
    `Doubao speech synthesis returned no audio for speaker ${speaker}${logId === undefined ? "" : ` (logid=${logId})`}`);

  return {
    audio,
    format: config.format,
    requestId,
    ...(logId === undefined ? {} : { logId }),
    ...(usage === undefined ? {} : { usage }),
    audioMessages,
  };
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Audio containers the V3 unidirectional synthesis endpoint can return. */
export const doubaoSpeechAudioFormats = ["mp3", "ogg_opus", "pcm", "wav"] as const;
export type DoubaoSpeechAudioFormat = (typeof doubaoSpeechAudioFormats)[number];

export type DoubaoSpeechConfig = {
  readonly path: string;
  readonly endpoint: string;
  /** Selects the synthesis product, and therefore the billing line. `seed-icl-2.0` is voice clone 2.0. */
  readonly resourceId: string;
  /** The console speaker id (音色ID) owned by the account behind the credential. */
  readonly speaker: string;
  readonly format: DoubaoSpeechAudioFormat;
  readonly sampleRate: number;
  /** -50..100. Service-side default when omitted. */
  readonly speechRate?: number;
  /** -50..100. Service-side default when omitted. */
  readonly loudnessRate?: number;
  readonly apiKey?: string;
  readonly appId?: string;
  readonly accessToken?: string;
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

function signedPercentage(value: unknown, subject: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  assert(typeof value === "number" && Number.isSafeInteger(value) && value >= -50 && value <= 100,
    `${subject} must be an integer between -50 and 100`);
  return value;
}

function audioFormat(value: unknown, subject: string): DoubaoSpeechAudioFormat {
  const result = value === undefined ? "mp3" : requiredString(value, subject);
  assert((doubaoSpeechAudioFormats as readonly string[]).includes(result),
    `${subject} must be one of ${doubaoSpeechAudioFormats.join(", ")}`);
  return result as DoubaoSpeechAudioFormat;
}

function sampleRate(value: unknown, subject: string): number {
  if (value === undefined || value === null) return 24_000;
  assert(typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    `${subject} must be a positive integer`);
  return value;
}

/** Read only the caller's explicit file or DOUBAO_TTS_CONFIG; never search other users' history. */
export async function readDoubaoSpeechConfig(path?: string): Promise<DoubaoSpeechConfig> {
  const selected = resolve(path ?? process.env.DOUBAO_TTS_CONFIG ?? "config.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(selected, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read Doubao TTS config at ${selected}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = object(expandEnvironment(raw), "Doubao TTS config");
  const tts = object(root.volc_tts, "volc_tts");

  const apiKey = optionalString(tts.api_key, "volc_tts.api_key");
  const appId = optionalString(tts.app_id, "volc_tts.app_id");
  const accessToken = optionalString(tts.access_token, "volc_tts.access_token");
  assert(apiKey !== undefined || (appId !== undefined && accessToken !== undefined),
    "volc_tts requires api_key or both app_id and access_token");
  assert(!(apiKey !== undefined && (appId !== undefined || accessToken !== undefined)),
    "volc_tts must use either api_key or app_id/access_token, not both");

  const speechRate = signedPercentage(tts.speech_rate, "volc_tts.speech_rate");
  const loudnessRate = signedPercentage(tts.loudness_rate, "volc_tts.loudness_rate");

  return {
    path: selected,
    endpoint: endpoint(tts.endpoint ?? "https://openspeech.bytedance.com", "volc_tts.endpoint"),
    resourceId: requiredString(tts.resource_id ?? "seed-icl-2.0", "volc_tts.resource_id"),
    // The console labels this field 音色ID, so accept the query-style name as well.
    speaker: requiredString(tts.speaker ?? tts.speaker_id, "volc_tts.speaker"),
    format: audioFormat(tts.format, "volc_tts.format"),
    sampleRate: sampleRate(tts.sample_rate, "volc_tts.sample_rate"),
    ...(speechRate === undefined ? {} : { speechRate }),
    ...(loudnessRate === undefined ? {} : { loudnessRate }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(appId === undefined ? {} : { appId }),
    ...(accessToken === undefined ? {} : { accessToken }),
  };
}

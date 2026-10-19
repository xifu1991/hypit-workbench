import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Audio containers the V3 unidirectional synthesis endpoint can return. */
export const doubaoSpeechAudioFormats = ["mp3", "ogg_opus", "pcm", "wav"] as const;
export type DoubaoSpeechAudioFormat = (typeof doubaoSpeechAudioFormats)[number];

export type HypitGatewaySpeechConfig = {
  readonly url: string;
  readonly token: string;
  /** Logical tenant voice name; the gateway maps it to the real Doubao speaker id. */
  readonly speaker?: string;
};

export type DoubaoSpeechConfig = {
  readonly path: string;
  readonly endpoint: string;
  /** Selects the synthesis product, and therefore the billing line. `seed-icl-2.0` is voice clone 2.0. */
  readonly resourceId: string;
  /** The console speaker id (音色ID) used when a line names no voice. */
  readonly speaker: string;
  /** Named voices (音色ID) for multi-speaker work such as dialogue: `{ "A": "S_...", "B": "S_..." }`. */
  readonly speakers: Readonly<Record<string, string>>;
  readonly format: DoubaoSpeechAudioFormat;
  readonly sampleRate: number;
  /** -50..100. Service-side default when omitted. */
  readonly speechRate?: number;
  /** -50..100. Service-side default when omitted. */
  readonly loudnessRate?: number;
  readonly apiKey?: string;
  readonly appId?: string;
  readonly accessToken?: string;
  /** When present, speech goes through the tenant gateway and never uses local Volc credentials. */
  readonly gateway?: HypitGatewaySpeechConfig;
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

function gatewayConfig(value: unknown): HypitGatewaySpeechConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const gateway = object(value, "hypit_gateway");
  assert(gateway.enabled === undefined || typeof gateway.enabled === "boolean",
    "hypit_gateway.enabled must be boolean");
  if (gateway.enabled !== true) return undefined;
  const speaker = optionalString(gateway.speaker, "hypit_gateway.speaker");
  return {
    url: endpoint(gateway.url, "hypit_gateway.url"),
    token: requiredString(gateway.token, "hypit_gateway.token"),
    ...(speaker === undefined ? {} : { speaker }),
  };
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

/** Named voices are the dialogue form of the same console speaker id list. */
function speakerMap(value: unknown, subject: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = object(value, subject);
  return Object.fromEntries(Object.entries(record).map(([name, item]) => [
    requiredString(name, `${subject} voice name`),
    requiredString(item, `${subject}.${name}`),
  ]));
}

/**
 * Resolve one line's voice: a name from `volc_tts.speakers`, a literal console speaker id, or the
 * default voice when no name is given. Unknown names fail with the voices the config does carry.
 */
export function resolveDoubaoSpeaker(config: DoubaoSpeechConfig, name?: string): string {
  const requested = name?.trim();
  if (requested === undefined || requested.length === 0) return config.speaker;
  const named = config.speakers[requested];
  if (named !== undefined) return named;
  // A literal id keeps one-off probes possible without editing the config.
  if (/^S_[A-Za-z0-9]+$/u.test(requested)) return requested;
  const available = Object.keys(config.speakers);
  const hint = available.length === 0
    ? "volc_tts.speakers is empty"
    : `available voices: ${available.join(", ")}`;
  throw new Error(`volc_tts.speakers has no voice named ${requested} (${hint})`);
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
  const gateway = gatewayConfig(root.hypit_gateway);
  if (gateway !== undefined) {
    return {
      path: selected,
      endpoint: gateway.url,
      resourceId: "hypit-gateway",
      speaker: gateway.speaker ?? "",
      speakers: {},
      format: "wav",
      sampleRate: 24_000,
      gateway,
    };
  }
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
  const speakers = speakerMap(tts.speakers, "volc_tts.speakers");
  // The console labels this field 音色ID, so accept the query-style name as well.
  const speaker = optionalString(tts.speaker ?? tts.speaker_id, "volc_tts.speaker");
  // A config that only lists named voices still has one: the first, which becomes the default.
  const fallbackSpeaker = Object.values(speakers)[0];
  assert(speaker !== undefined || fallbackSpeaker !== undefined, "volc_tts.speaker is required");

  return {
    path: selected,
    endpoint: endpoint(tts.endpoint ?? "https://openspeech.bytedance.com", "volc_tts.endpoint"),
    resourceId: requiredString(tts.resource_id ?? "seed-icl-2.0", "volc_tts.resource_id"),
    speaker: speaker ?? fallbackSpeaker!,
    speakers,
    format: audioFormat(tts.format, "volc_tts.format"),
    sampleRate: sampleRate(tts.sample_rate, "volc_tts.sample_rate"),
    ...(speechRate === undefined ? {} : { speechRate }),
    ...(loudnessRate === undefined ? {} : { loudnessRate }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(appId === undefined ? {} : { appId }),
    ...(accessToken === undefined ? {} : { accessToken }),
  };
}

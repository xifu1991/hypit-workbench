import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The Doubao speech providers read one shared JSON file, so Studio edits that file
 * instead of asking the operator to hand-edit credentials. The read path never
 * returns a stored secret: callers only learn whether one exists.
 */

export type ProviderFieldKind = "text" | "secret" | "boolean" | "number" | "choice";

export type ProviderField = {
  readonly key: string;
  readonly kind: ProviderFieldKind;
  readonly label: string;
  readonly choices?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly placeholder?: string;
  /**
   * Hides a field that does not apply to the credential style in the file, such
   * as the api_key alternative to an app_id/access_token pair. Hidden fields stay
   * writable, so a hand-written or pulled config can still switch styles.
   */
  readonly appliesWhen?: (values: Record<string, unknown>) => boolean;
};

export type ProviderGroup = {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly ProviderField[];
};

/** Doubao speech accepts api_key or an app_id/access_token pair, never both. */
const usesAppCredentials = (values: Record<string, unknown>): boolean =>
  stored(values.app_id) || stored(values.access_token);

export const providerGroups: readonly ProviderGroup[] = [
  {
    id: "hypit_gateway",
    label: "providers.group.gateway",
    fields: [
      { key: "enabled", kind: "boolean", label: "providers.field.gateway-enabled" },
      { key: "url", kind: "text", label: "providers.field.gateway-url", placeholder: "https://gateway.example.com" },
      { key: "token", kind: "secret", label: "providers.field.gateway-token" },
      { key: "speaker", kind: "text", label: "providers.field.gateway-speaker", placeholder: "默认音色" },
    ],
  },
  {
    id: "volc_asr",
    label: "providers.group.asr",
    fields: [
      { key: "api_key", kind: "secret", label: "providers.field.api-key", appliesWhen: (values) => !usesAppCredentials(values) },
      { key: "app_id", kind: "text", label: "providers.field.app-id", appliesWhen: usesAppCredentials },
      { key: "access_token", kind: "secret", label: "providers.field.access-token", appliesWhen: usesAppCredentials },
      { key: "endpoint", kind: "text", label: "providers.field.endpoint", placeholder: "https://openspeech.bytedance.com" },
      { key: "resource_id", kind: "text", label: "providers.field.resource-id", placeholder: "volc.seedasr.auc" },
      { key: "enable_speaker", kind: "boolean", label: "providers.field.enable-speaker" },
    ],
  },
  {
    id: "volc_tos",
    label: "providers.group.tos",
    fields: [
      { key: "access_key", kind: "secret", label: "providers.field.access-key" },
      { key: "secret_key", kind: "secret", label: "providers.field.secret-key" },
      { key: "endpoint", kind: "text", label: "providers.field.endpoint", placeholder: "tos-cn-beijing.volces.com" },
      { key: "region", kind: "text", label: "providers.field.region", placeholder: "cn-beijing" },
      { key: "bucket", kind: "text", label: "providers.field.bucket" },
    ],
  },
  {
    id: "volc_tts",
    label: "providers.group.voice-clone",
    fields: [
      { key: "api_key", kind: "secret", label: "providers.field.api-key", appliesWhen: (values) => !usesAppCredentials(values) },
      { key: "app_id", kind: "text", label: "providers.field.app-id", appliesWhen: usesAppCredentials },
      { key: "access_token", kind: "secret", label: "providers.field.access-token", appliesWhen: usesAppCredentials },
      { key: "endpoint", kind: "text", label: "providers.field.endpoint", placeholder: "https://openspeech.bytedance.com" },
      { key: "resource_id", kind: "text", label: "providers.field.resource-id", placeholder: "seed-icl-2.0" },
      { key: "speaker", kind: "text", label: "providers.field.speaker", placeholder: "S_" },
      { key: "format", kind: "choice", label: "providers.field.format", choices: ["mp3", "ogg_opus", "pcm", "wav"] },
      { key: "sample_rate", kind: "number", label: "providers.field.sample-rate", minimum: 1, maximum: 192_000, placeholder: "24000" },
      { key: "speech_rate", kind: "number", label: "providers.field.speech-rate", minimum: -50, maximum: 100 },
      { key: "loudness_rate", kind: "number", label: "providers.field.loudness-rate", minimum: -50, maximum: 100 },
    ],
  },
];

export type ProviderFieldView = {
  readonly key: string;
  readonly kind: ProviderFieldKind;
  readonly label: string;
  readonly choices?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly placeholder?: string;
  readonly value: string | number | boolean | null;
  /** A stored secret stays on disk; the viewer only learns that it is there. */
  readonly stored: boolean;
};

export type ProviderGroupView = {
  readonly id: string;
  readonly label: string;
  readonly fields: readonly ProviderFieldView[];
};

export type ProviderRemoteState = {
  readonly configured: boolean;
  readonly url: string | null;
  readonly pulledAt: string | null;
  readonly error: string | null;
};

export type ProviderSettingsView = {
  readonly format: "hypit.provider-settings@1";
  readonly path: string;
  readonly exists: boolean;
  readonly groups: readonly ProviderGroupView[];
  readonly remote: ProviderRemoteState;
};

export type ProviderSettingsPatch = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

type ConfigFile = {
  readonly exists: boolean;
  readonly document: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readConfigFile(path: string): Promise<ConfigFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, document: {} };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Provider config is not valid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const document = record(parsed);
  if (document === null) throw new Error(`Provider config must be a JSON object at ${path}`);
  return { exists: true, document };
}

export type GatewayConnectionConfig = {
  readonly url: string;
  readonly token: string;
  readonly speaker?: string;
};

/** Reads the gateway connection without returning it through the settings view. */
export async function readGatewayConnectionConfig(path: string): Promise<GatewayConnectionConfig> {
  const { exists, document } = await readConfigFile(path);
  if (!exists) throw new Error(`Provider config does not exist at ${path}`);
  const gateway = record(document.hypit_gateway);
  if (gateway === null || gateway.enabled !== true) {
    throw new Error("Enable the Hypit platform gateway and save the settings first.");
  }
  const rawUrl = typeof gateway.url === "string" ? gateway.url.trim() : "";
  const rawToken = typeof gateway.token === "string" ? gateway.token.trim() : "";
  if (rawUrl.length === 0) throw new Error("hypit_gateway.url is required");
  if (rawToken.length === 0) throw new Error("hypit_gateway.token is required");
  const parsed = new URL(rawUrl.includes("://") ? rawUrl : `https://${rawUrl}`);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("hypit_gateway.url must be an HTTP(S) endpoint");
  }
  const speaker = typeof gateway.speaker === "string" && gateway.speaker.trim().length > 0
    ? gateway.speaker.trim()
    : undefined;
  return {
    url: rawUrl.replace(/\/+$/u, ""),
    token: rawToken,
    ...(speaker === undefined ? {} : { speaker }),
  };
}

function stored(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function fieldView(field: ProviderField, group: Record<string, unknown>): ProviderFieldView {
  const raw = group[field.key];
  const shared = {
    key: field.key,
    kind: field.kind,
    label: field.label,
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
    ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
  };
  if (field.kind === "secret") return { ...shared, value: null, stored: stored(raw) };
  if (field.kind === "boolean") return { ...shared, value: typeof raw === "boolean" ? raw : null, stored: raw !== undefined };
  if (field.kind === "number") {
    return { ...shared, value: typeof raw === "number" && Number.isFinite(raw) ? raw : null, stored: raw !== undefined };
  }
  return { ...shared, value: stored(raw) ? String(raw) : null, stored: stored(raw) };
}

export async function readProviderSettings(path: string, remote: ProviderRemoteState): Promise<ProviderSettingsView> {
  const { exists, document } = await readConfigFile(path);
  const gateway = record(document.hypit_gateway);
  const gatewayEnabled = gateway?.enabled === true;
  return {
    format: "hypit.provider-settings@1",
    path,
    exists,
    groups: providerGroups
      .filter((group) => !gatewayEnabled || group.id === "hypit_gateway")
      .map((group) => {
        const values = record(document[group.id]) ?? {};
        return {
          id: group.id,
          label: group.label,
          fields: group.fields
            .filter((field) => field.appliesWhen === undefined || field.appliesWhen(values))
            .map((field) => fieldView(field, values)),
        };
      }),
    remote,
  };
}

/**
 * Accepts only the values a field can hold. An empty string keeps whatever is
 * already stored, so a masked secret is never cleared by saving the form.
 */
export function providerSettingsPatch(value: unknown): ProviderSettingsPatch {
  const submitted = record(value);
  if (submitted === null) throw new Error("Provider settings must be an object.");
  const patch: Record<string, Record<string, unknown>> = {};
  for (const [groupId, rawGroup] of Object.entries(submitted)) {
    const group = providerGroups.find((candidate) => candidate.id === groupId);
    if (group === undefined) throw new Error(`Unknown provider settings group: ${groupId}`);
    const submittedFields = record(rawGroup);
    if (submittedFields === null) throw new Error(`${groupId} must be an object.`);
    const fields: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(submittedFields)) {
      const subject = `${groupId}.${key}`;
      const field = group.fields.find((candidate) => candidate.key === key);
      if (raw === null) {
        fields[key] = null;
        continue;
      }
      if (typeof raw === "string") {
        const text = raw.trim();
        if (text.length === 0) continue;
        if (field !== undefined && (field.kind === "secret" || field.kind === "text" || field.kind === "choice")) {
          if (field.kind === "choice" && field.choices !== undefined && !field.choices.includes(text)) {
            throw new Error(`${subject} must be one of ${field.choices.join(", ")}`);
          }
          fields[key] = text;
          continue;
        }
        if (field === undefined) {
          fields[key] = text;
          continue;
        }
        throw new Error(`${subject} must be a ${field.kind}`);
      }
      if (typeof raw === "boolean") {
        if (field !== undefined && field.kind !== "boolean") throw new Error(`${subject} must be a ${field.kind}`);
        fields[key] = raw;
        continue;
      }
      if (typeof raw === "number" && Number.isSafeInteger(raw)) {
        if (field !== undefined) {
          if (field.kind !== "number") throw new Error(`${subject} must be a ${field.kind}`);
          if (field.minimum !== undefined && raw < field.minimum) throw new Error(`${subject} must be at least ${field.minimum}`);
          if (field.maximum !== undefined && raw > field.maximum) throw new Error(`${subject} must be at most ${field.maximum}`);
        }
        fields[key] = raw;
        continue;
      }
      throw new Error(`${subject} must be a string, integer or boolean`);
    }
    if (Object.keys(fields).length > 0) patch[groupId] = fields;
  }
  return patch;
}

/** Merges the patch into the file, leaving hand-written keys and comments intact. */
export async function writeProviderSettings(path: string, patch: ProviderSettingsPatch): Promise<void> {
  const { document } = await readConfigFile(path);
  const next: Record<string, unknown> = { ...document };
  for (const [groupId, fields] of Object.entries(patch)) {
    const group = { ...(record(next[groupId]) ?? {}) };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete group[key];
      else group[key] = value;
    }
    next[groupId] = group;
  }
  const temporary = join(dirname(path), `.${path.split(/[\\/]/u).at(-1)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export type RemoteSettingsSource = {
  readonly url: string;
  readonly token: string | null;
};

export function remoteSettingsSource(env: NodeJS.ProcessEnv = process.env): RemoteSettingsSource | null {
  const url = env.HYPIT_SETTINGS_URL?.trim();
  if (url === undefined || url.length === 0) return null;
  const token = env.HYPIT_SETTINGS_TOKEN?.trim();
  return { url, token: token !== undefined && token.length > 0 ? token : null };
}

export type RemoteSettingsPull = {
  readonly groups: ProviderSettingsPatch;
  /** Field names the remote document tried to set, and that were refused. */
  readonly refusedSecrets: readonly string[];
};

/**
 * Only non-secret fields cross the network. A remote document may describe an
 * endpoint or a voice, but it can never install a credential on this machine.
 */
export async function pullProviderSettings(source: RemoteSettingsSource, timeoutMs = 10_000): Promise<RemoteSettingsPull> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body: unknown;
  try {
    const response = await fetch(source.url, {
      headers: source.token === null ? {} : { authorization: `Bearer ${source.token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Remote settings responded ${response.status}.`);
    body = await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
  const envelope = record(body) ?? {};
  const raw = record(envelope.groups) ?? envelope;
  const groups: Record<string, Record<string, unknown>> = {};
  const refusedSecrets: string[] = [];
  for (const group of providerGroups) {
    const candidate = record(raw[group.id]);
    if (candidate === null) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidate)) {
      const field = group.fields.find((item) => item.key === key);
      if (field === undefined) continue;
      if (field.kind === "secret") {
        refusedSecrets.push(`${group.id}.${key}`);
        continue;
      }
      try {
        Object.assign(fields, providerSettingsPatch({ [group.id]: { [key]: value } })[group.id] ?? {});
      } catch {
        refusedSecrets.push(`${group.id}.${key}`);
      }
    }
    if (Object.keys(fields).length > 0) groups[group.id] = fields;
  }
  return { groups, refusedSecrets };
}

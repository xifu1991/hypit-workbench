import { join } from "node:path";

import type { Plugin } from "vite";
import {
  providerSettingsPatch,
  pullProviderSettings,
  readGatewayConnectionConfig,
  readProviderSettings,
  remoteSettingsSource,
  writeProviderSettings,
  type GatewayConnectionConfig,
  type ProviderRemoteState,
} from "./provider-settings.js";

export type StudioProviderSettingsOptions = {
  readonly workspaceRoot: string;
  /** Defaults to HYPIT_PROVIDER_CONFIG, then <workspace>/config.json. */
  readonly configPath?: string;
};

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}

const settingsPath = "/__studio/provider-settings";
const gatewayCheckPath = `${settingsPath}/gateway-check`;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function checkGatewayConnection(gateway: GatewayConnectionConfig) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${gateway.url}/gateway/v1/me`, {
      headers: { authorization: `Bearer ${gateway.token}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown = {};
    try {
      body = text.trim().length === 0 ? {} : JSON.parse(text) as unknown;
    } catch {
      if (!response.ok) throw new Error(`Gateway responded ${response.status}: ${text.slice(0, 300)}`);
      throw new Error("Gateway returned invalid JSON.");
    }
    const envelope = record(body) ?? {};
    if (!response.ok) {
      const message = typeof envelope.message === "string" ? envelope.message : text.slice(0, 300);
      throw new Error(`Gateway responded ${response.status}: ${message}`);
    }
    const tenant = record(envelope.tenant) ?? {};
    const wallet = record(envelope.wallet) ?? {};
    const voices = Array.isArray(envelope.voices) ? envelope.voices : [];
    return {
      ok: true,
      tenant: {
        id: typeof tenant.id === "string" ? tenant.id : null,
        name: typeof tenant.name === "string" ? tenant.name : null,
        status: typeof tenant.status === "string" ? tenant.status : null,
      },
      wallet: {
        balanceFen: numberOrNull(wallet.balanceFen),
        reservedFen: numberOrNull(wallet.reservedFen),
        availableFen: numberOrNull(wallet.availableFen),
      },
      voiceCount: voices.length,
      defaultSpeaker: gateway.speaker ?? null,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function studioProviderSettingsPlugin(options: StudioProviderSettingsOptions): Plugin {
  const configured = options.configPath?.trim();
  const fromEnvironment = process.env.HYPIT_PROVIDER_CONFIG?.trim();
  const configPath = configured !== undefined && configured.length > 0
    ? configured
    : fromEnvironment !== undefined && fromEnvironment.length > 0
      ? fromEnvironment
      : join(options.workspaceRoot, "config.json");
  const source = remoteSettingsSource();
  let pulledAt: string | null = null;
  let remoteError: string | null = null;
  const remoteState = (): ProviderRemoteState => ({
    configured: source !== null,
    url: source?.url ?? null,
    pulledAt,
    error: remoteError,
  });
  const view = () => readProviderSettings(configPath, remoteState());

  return {
    name: "hypit-studio-provider-settings",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://studio.hypit.local");
        if (url.pathname !== settingsPath
          && url.pathname !== `${settingsPath}/pull`
          && url.pathname !== gatewayCheckPath) {
          next();
          return;
        }
        void (async () => {
          try {
            if (url.pathname === gatewayCheckPath) {
              if (request.method !== "POST") {
                response.statusCode = 405;
                response.end();
                return;
              }
              json(response, 200, await checkGatewayConnection(await readGatewayConnectionConfig(configPath)));
              return;
            }
            if (url.pathname === `${settingsPath}/pull`) {
              if (request.method !== "POST") {
                response.statusCode = 405;
                response.end();
                return;
              }
              if (source === null) throw new Error("No remote provider settings source is configured.");
              let pulled;
              try {
                pulled = await pullProviderSettings(source);
              } catch (error) {
                remoteError = error instanceof Error ? error.message : String(error);
                throw error;
              }
              if (Object.keys(pulled.groups).length > 0) await writeProviderSettings(configPath, pulled.groups);
              pulledAt = new Date().toISOString();
              remoteError = null;
              json(response, 200, { ...(await view()), applied: Object.keys(pulled.groups), refusedSecrets: pulled.refusedSecrets });
              return;
            }
            if (request.method === "GET") {
              json(response, 200, await view());
              return;
            }
            if (request.method !== "PUT") {
              response.statusCode = 405;
              response.end();
              return;
            }
            const patch = providerSettingsPatch(await readRequestBody(request));
            if (Object.keys(patch).length > 0) await writeProviderSettings(configPath, patch);
            json(response, 200, await view());
          } catch (error) {
            json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        })();
      });
    },
  };
}

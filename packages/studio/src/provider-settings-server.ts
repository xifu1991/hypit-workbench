import { join } from "node:path";

import type { Plugin } from "vite";
import {
  providerSettingsPatch,
  pullProviderSettings,
  readProviderSettings,
  remoteSettingsSource,
  writeProviderSettings,
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
        if (url.pathname !== settingsPath && url.pathname !== `${settingsPath}/pull`) {
          next();
          return;
        }
        void (async () => {
          try {
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

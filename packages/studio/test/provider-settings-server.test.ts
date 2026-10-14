import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createRemote } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";

import { studioProviderSettingsPlugin } from "../src/provider-settings-server.js";

async function studio(t: { after(callback: () => Promise<void>): void }, root: string, configPath: string): Promise<string> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [studioProviderSettingsPlugin({ workspaceRoot: root, configPath })],
  });
  await server.listen();
  t.after(() => server.close());
  const address = server.httpServer?.address();
  assert.ok(address !== null && address !== undefined && typeof address === "object");
  return `http://127.0.0.1:${address.port}/__studio/provider-settings`;
}

async function workspace(t: { after(callback: () => Promise<void>): void }, document: unknown): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "hypit-provider-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`);
  return { root, configPath };
}

async function documentOf(path: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, unknown>>;
}

test("the settings endpoint reads, writes and reports errors over HTTP", async (t) => {
  const { root, configPath } = await workspace(t, { volc_asr: { api_key: "kept-secret", _填写提示: "hand written" } });
  const url = await studio(t, root, configPath);

  const initial = await (await fetch(url)).json() as { path: string; groups: unknown[] };
  assert.equal(initial.path, configPath);
  assert.equal(initial.groups.length, 3);
  assert.equal(JSON.stringify(initial).includes("kept-secret"), false);

  // A blank secret arrives as an absent field, so the stored key survives.
  const saved = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ volc_asr: { api_key: "", resource_id: "volc.seedasr.auc" } }),
  });
  assert.equal(saved.status, 200);
  const document = await documentOf(configPath);
  assert.equal(document.volc_asr?.api_key, "kept-secret");
  assert.equal(document.volc_asr?.resource_id, "volc.seedasr.auc");
  assert.equal(document.volc_asr?._填写提示, "hand written");

  const rejected = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ volc_nowhere: {} }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json() as { error: string }).error, /Unknown provider settings group/u);
  assert.deepEqual(await documentOf(configPath), document);
});

test("pulling settings keeps remote secrets out of the local config file", async (t) => {
  const { root, configPath } = await workspace(t, { volc_tts: { api_key: "local-secret" } });
  const remote = createRemote((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ groups: {
      volc_tts: { api_key: "remote-secret", speaker: "S_shared", resource_id: "seed-icl-2.0" },
      volc_tos: { bucket: "shared-bucket" },
    } }));
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => remote.close(() => resolve())));
  const address = remote.address();
  assert.ok(address !== null && typeof address === "object");

  const previous = process.env.HYPIT_SETTINGS_URL;
  process.env.HYPIT_SETTINGS_URL = `http://127.0.0.1:${address.port}/settings.json`;
  t.after(() => {
    if (previous === undefined) delete process.env.HYPIT_SETTINGS_URL;
    else process.env.HYPIT_SETTINGS_URL = previous;
  });
  const url = await studio(t, root, configPath);

  const before = await (await fetch(url)).json() as { remote: { configured: boolean; url: string } };
  assert.equal(before.remote.configured, true);
  assert.equal(before.remote.url, process.env.HYPIT_SETTINGS_URL);

  const pulled = await (await fetch(`${url}/pull`, { method: "POST" })).json() as {
    applied: string[];
    refusedSecrets: string[];
    remote: { pulledAt: string | null; error: string | null };
  };
  // Applied groups follow the settings schema order, not the remote document order.
  assert.deepEqual(pulled.applied, ["volc_tos", "volc_tts"]);
  assert.deepEqual(pulled.refusedSecrets, ["volc_tts.api_key"]);
  assert.equal(pulled.remote.error, null);
  assert.notEqual(pulled.remote.pulledAt, null);

  const document = await documentOf(configPath);
  assert.equal(document.volc_tts?.api_key, "local-secret");
  assert.equal(document.volc_tts?.speaker, "S_shared");
  assert.equal(document.volc_tos?.bucket, "shared-bucket");
  assert.equal(JSON.stringify(document).includes("remote-secret"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  providerSettingsPatch,
  pullProviderSettings,
  readProviderSettings,
  writeProviderSettings,
} from "../src/provider-settings.js";

const offline = { configured: false, url: null, pulledAt: null, error: null } as const;

async function workspace(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hypit-providers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("reading provider settings reports stored secrets without returning them", async (t) => {
  const root = await workspace(t);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({
    volc_asr: { api_key: "AKIA-live-9999", endpoint: "https://openspeech.bytedance.com", enable_speaker: false },
    volc_tts: { speaker: "S_demo" },
    _备注: "hand written",
  }));

  const view = await readProviderSettings(path, offline);
  assert.equal(view.path, path);
  assert.equal(view.exists, true);
  const asr = view.groups.find((group) => group.id === "volc_asr");
  assert.equal(asr?.fields.find((field) => field.key === "api_key")?.value, null);
  assert.equal(asr?.fields.find((field) => field.key === "api_key")?.stored, true);
  assert.equal(asr?.fields.find((field) => field.key === "endpoint")?.value, "https://openspeech.bytedance.com");
  assert.equal(asr?.fields.find((field) => field.key === "enable_speaker")?.value, false);
  // The stored key selects the api_key style, so the alternative pair is not offered.
  assert.deepEqual(asr?.fields.map((field) => field.key), ["api_key", "endpoint", "resource_id", "enable_speaker"]);
  assert.equal(JSON.stringify(view).includes("AKIA-live-9999"), false);
});

test("an app_id/access_token config offers those fields instead of the api key", async (t) => {
  const root = await workspace(t);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ volc_tts: { app_id: "1234567890", access_token: "paired-token" } }));

  const view = await readProviderSettings(path, offline);
  const tts = view.groups.find((group) => group.id === "volc_tts");
  const keys = tts?.fields.map((field) => field.key) ?? [];
  assert.deepEqual(keys.slice(0, 3), ["app_id", "access_token", "endpoint"]);
  assert.equal(keys.includes("api_key"), false);
  assert.equal(tts?.fields.find((field) => field.key === "app_id")?.value, "1234567890");
  assert.equal(tts?.fields.find((field) => field.key === "access_token")?.value, null);
  assert.equal(tts?.fields.find((field) => field.key === "access_token")?.stored, true);
  assert.equal(JSON.stringify(view).includes("paired-token"), false);
});

test("a missing config file reads as an empty document", async (t) => {
  const root = await workspace(t);
  const view = await readProviderSettings(join(root, "config.json"), offline);
  assert.equal(view.exists, false);
  assert.equal(view.groups.every((group) => group.fields.every((field) => field.value === null)), true);
});

test("a patch keeps blank fields out, so saving an untouched form preserves stored secrets", async (t) => {
  const root = await workspace(t);
  const path = join(root, "config.json");
  await writeFile(path, JSON.stringify({ volc_asr: { api_key: "kept", _填写提示: "keep me" } }));

  const patch = providerSettingsPatch({ volc_asr: { api_key: "", app_id: " 123 ", resource_id: null } });
  await writeProviderSettings(path, patch);

  const document = JSON.parse(await readFile(path, "utf8")) as Record<string, Record<string, unknown>>;
  assert.equal(document.volc_asr?.api_key, "kept");
  assert.equal(document.volc_asr?.app_id, "123");
  assert.equal(Object.hasOwn(document.volc_asr ?? {}, "resource_id"), false);
  assert.equal(document.volc_asr?._填写提示, "keep me");
});

test("a patch rejects unknown groups, wrong types and out-of-range numbers", () => {
  assert.throws(() => providerSettingsPatch({ volc_missing: {} }), /Unknown provider settings group/u);
  assert.throws(() => providerSettingsPatch({ volc_asr: "text" }), /must be an object/u);
  assert.throws(() => providerSettingsPatch({ volc_asr: { enable_speaker: "yes" } }), /must be a boolean/u);
  assert.throws(() => providerSettingsPatch({ volc_tts: { sample_rate: 10_000_000 } }), /at most 192000/u);
  assert.throws(() => providerSettingsPatch({ volc_tts: { format: "flac" } }), /must be one of/u);
  assert.deepEqual(providerSettingsPatch({ volc_tts: { format: "mp3", speech_rate: -20 } }), {
    volc_tts: { format: "mp3", speech_rate: -20 },
  });
});

test("pulling from a remote source refuses secrets and applies ordinary fields", async (t) => {
  const remote = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      groups: {
        volc_asr: { api_key: "remote-secret", resource_id: "volc.seedasr.auc" },
        volc_tos: { bucket: "shared-bucket", secret_key: "remote-secret" },
        volc_tts: { speaker: "S_shared", sample_rate: "not-a-number" },
      },
    }));
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => remote.close(() => resolve())));
  const address = remote.address();
  assert.ok(address !== null && typeof address === "object");

  const pulled = await pullProviderSettings({ url: `http://127.0.0.1:${address.port}/settings.json`, token: "token" });
  assert.deepEqual(pulled.groups, {
    volc_asr: { resource_id: "volc.seedasr.auc" },
    volc_tos: { bucket: "shared-bucket" },
    volc_tts: { speaker: "S_shared" },
  });
  assert.deepEqual(pulled.refusedSecrets, [
    "volc_asr.api_key",
    "volc_tos.secret_key",
    "volc_tts.sample_rate",
  ]);
});

test("a remote source that fails reports the failure instead of writing", async (t) => {
  const remote = createServer((_request, response) => {
    response.statusCode = 500;
    response.end("nope");
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => remote.close(() => resolve())));
  const address = remote.address();
  assert.ok(address !== null && typeof address === "object");

  await assert.rejects(
    () => pullProviderSettings({ url: `http://127.0.0.1:${address.port}/settings.json`, token: null }),
    /responded 500/u,
  );
});

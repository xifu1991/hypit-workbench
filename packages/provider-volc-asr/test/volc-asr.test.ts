import assert from "node:assert/strict";
import test from "node:test";

import type { VolcConfig } from "../src/config.js";
import { transcribeVolc } from "../src/volc-asr.js";

const config: VolcConfig = {
  path: "test-config.json",
  asr: {
    endpoint: "https://openspeech.bytedance.com",
    resourceId: "volc.seedasr.auc",
    apiKey: "test-api-key",
    enableSpeaker: true,
  },
  tos: {
    accessKey: "test-access-key",
    secretKey: "test-secret-key",
    endpoint: "https://tos.example.com",
    region: "cn-beijing",
    bucket: "test-bucket",
  },
};

test("Doubao transcription uploads evidence, polls once, and always deletes its TOS object", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ readonly url: string; readonly method: string; readonly body?: unknown }> = [];
  const audio = new Uint8Array([1, 2, 3, 4]);
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, ...(init?.body === undefined ? {} : { body: init.body }) });
    if (method === "PUT") {
      assert.match(url, /^https:\/\/test-bucket\.tos\.example\.com\//u);
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/api/v3/auc/bigmodel/submit")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.audio !== undefined && (body.audio as { readonly format?: unknown }).format, "wav");
      return new Response("{}", {
        status: 200,
        headers: { "x-api-status-code": "0" },
      });
    }
    if (url.endsWith("/api/v3/auc/bigmodel/query")) {
      return new Response(JSON.stringify({
        result: {
          utterances: [{ text: "hello", start_time: 100, end_time: 700 }],
        },
      }), {
        status: 200,
        headers: { "x-api-status-code": "0" },
      });
    }
    if (method === "DELETE") return new Response(null, { status: 200 });
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;

  try {
    const response = await transcribeVolc({
      config,
      audio,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
      deleteTemporaryObject: true,
      temporaryObjectPrefix: "hypit-test",
      presignExpiresSeconds: 60,
    });
    assert.equal((response.result as { readonly utterances?: readonly unknown[] }).utterances?.length, 1);
    assert.deepEqual(calls.map((call) => call.method).filter((method) => method !== "POST"), ["PUT", "DELETE"]);
    assert.equal(Buffer.compare(Buffer.from(calls[0]!.body as ArrayBuffer), Buffer.from(audio)), 0);
    assert.equal(new Set(calls.filter((call) => call.method === "POST").map((call) => call.url)).size, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

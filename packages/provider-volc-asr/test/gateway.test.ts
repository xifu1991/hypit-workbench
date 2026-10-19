import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VolcConfig } from "../src/config.js";
import { readVolcConfig } from "../src/config.js";
import { transcribeVolc } from "../src/volc-asr.js";

const gatewayConfig: VolcConfig = {
  path: "gateway-config.json",
  gateway: {
    url: "https://gateway.example.com",
    token: "hgt_asr_token",
  },
  asr: {
    endpoint: "https://gateway.example.com",
    resourceId: "hypit-gateway",
    enableSpeaker: true,
  },
};

test("gateway ASR uploads WAV bytes with a stable idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{
    readonly url: string;
    readonly headers: Headers;
    readonly audio: Uint8Array;
  }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      audio: new Uint8Array(init?.body as ArrayBuffer),
    });
    return new Response(JSON.stringify({
      result: {
        result: {
          utterances: [{ text: "hello", start_time: 0, end_time: 100 }],
        },
      },
      taskId: "job_asr_1",
      costFen: 2,
      balanceFen: 998,
      replay: false,
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const first = await transcribeVolc({
      config: gatewayConfig,
      audio,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
      deleteTemporaryObject: true,
      temporaryObjectPrefix: "unused",
      presignExpiresSeconds: 60,
    });
    await transcribeVolc({
      config: gatewayConfig,
      audio,
      requestTimeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
      deleteTemporaryObject: true,
      temporaryObjectPrefix: "unused",
      presignExpiresSeconds: 60,
    });

    assert.deepEqual(first, {
      result: {
        utterances: [{ text: "hello", start_time: 0, end_time: 100 }],
      },
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/gateway\/v1\/asr$/u);
    assert.equal(calls[0]!.headers.get("authorization"), "Bearer hgt_asr_token");
    assert.equal(calls[0]!.headers.get("content-type"), "audio/wav");
    assert.equal(calls[0]!.headers.get("idempotency-key"), calls[1]!.headers.get("idempotency-key"));
    assert.deepEqual([...calls[0]!.audio], [...audio]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway ASR reports a stopped or unpaid tenant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: "tenant_disabled",
    message: "This tenant is disabled",
  }), { status: 403 })) as typeof fetch;
  try {
    await assert.rejects(
      transcribeVolc({
        config: gatewayConfig,
        audio: new Uint8Array([1, 2, 3, 4]),
        requestTimeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
        deleteTemporaryObject: true,
        temporaryObjectPrefix: "unused",
        presignExpiresSeconds: 60,
      }),
      /HTTP 403 code=tenant_disabled: This tenant is disabled/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway-only ASR config does not require Volc ASR or TOS credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "volc-asr-gateway-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({
      hypit_gateway: {
        enabled: true,
        url: "https://gateway.example.com/",
        token: "hgt_config_token",
      },
    }), "utf8");
    const loaded = await readVolcConfig(path);
    assert.deepEqual(loaded.gateway, {
      url: "https://gateway.example.com",
      token: "hgt_config_token",
    });
    assert.equal(loaded.tos, undefined);
    assert.equal(loaded.asr.resourceId, "hypit-gateway");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

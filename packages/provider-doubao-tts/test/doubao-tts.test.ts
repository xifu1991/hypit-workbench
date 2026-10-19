import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DoubaoSpeechConfig } from "../src/config.js";
import { readDoubaoSpeechConfig, resolveDoubaoSpeaker } from "../src/config.js";
import { synthesizeDoubaoSpeech } from "../src/speech.js";

const config: DoubaoSpeechConfig = {
  path: "test-config.json",
  endpoint: "https://openspeech.bytedance.com",
  resourceId: "seed-icl-2.0",
  speaker: "S_NMb2Ke502",
  speakers: {},
  format: "mp3",
  sampleRate: 24_000,
  apiKey: "test-api-key",
};

/** Emit the payload in awkward slices so message boundaries never line up with transport reads. */
function streamOf(payload: string, slice: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(payload);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += slice) {
        controller.enqueue(bytes.subarray(offset, offset + slice));
      }
      controller.close();
    },
  });
}

type CapturedRequest = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
};

async function withFetch(
  response: () => Response,
  body: (captured: () => readonly CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input, init) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return response();
  }) as typeof fetch;
  try {
    await body(() => captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Doubao synthesis reassembles Base64 audio split across transport boundaries", async () => {
  const first = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const second = Buffer.from([8, 9, 10, 11]);
  const payload = [
    JSON.stringify({ code: 0, message: "ok", data: first.toString("base64") }),
    JSON.stringify({ code: 0, message: "ok", data: second.toString("base64") }),
    JSON.stringify({ code: 20000000, message: "done", usage: { text_words: 4 } }),
    "",
  ].join("\n");

  await withFetch(
    () => new Response(streamOf(payload, 7), { status: 200, headers: { "x-tt-logid": "test-logid" } }),
    async (captured) => {
      const result = await synthesizeDoubaoSpeech({ config, text: "  各位好，这里是测试。  " });
      assert.deepEqual(Buffer.from(result.audio), Buffer.concat([first, second]));
      assert.equal(result.audioMessages, 2);
      assert.equal(result.logId, "test-logid");
      assert.deepEqual(result.usage, { text_words: 4 });

      const request = captured()[0]!;
      assert.match(request.url, /\/api\/v3\/tts\/unidirectional$/u);
      assert.equal(request.headers.get("x-api-key"), "test-api-key");
      assert.equal(request.headers.get("x-api-resource-id"), "seed-icl-2.0");
      assert.equal(request.body.req_params !== undefined
        && (request.body.req_params as { readonly speaker?: unknown }).speaker, "S_NMb2Ke502");
      const reqParams = request.body.req_params as {
        readonly text: string;
        readonly audio_params: { readonly format: string; readonly sample_rate: number };
      };
      assert.equal(reqParams.text, "各位好，这里是测试。");
      assert.deepEqual(reqParams.audio_params, { format: "mp3", sample_rate: 24_000 });
    },
  );
});

test("Doubao synthesis names the missing product when the account is not granted the resource", async () => {
  await withFetch(
    () => new Response(JSON.stringify({
      header: { reqid: "req-1", code: 45000030, message: "[resource_id=volc.seedicl.default] requested resource not granted" },
    }), { status: 403 }),
    async () => {
      await assert.rejects(
        synthesizeDoubaoSpeech({ config, text: "测试" }),
        (error: Error) => {
          assert.match(error.message, /HTTP 403/u);
          assert.match(error.message, /code=45000030/u);
          assert.match(error.message, /requested resource not granted/u);
          assert.match(error.message, /S_NMb2Ke502/u);
          assert.match(error.message, /seed-icl-2\.0/u);
          assert.match(error.message, /has not activated the product/u);
          return true;
        },
      );
    },
  );
});

test("Doubao synthesis speaks the voice a dialogue line names", async () => {
  const dialogue: DoubaoSpeechConfig = {
    ...config,
    speakers: { HOST: "S_NMb2Ke502", GUEST: "S_GuestVoice01" },
  };
  const progress: string[] = [];
  await withFetch(
    () => new Response(streamOf(`${JSON.stringify({ code: 20000000, data: Buffer.from([1, 2]).toString("base64") })}\n`, 4), { status: 200 }),
    async (captured) => {
      await synthesizeDoubaoSpeech({
        config: dialogue,
        text: "那你说说看。",
        speaker: "GUEST",
        reportProgress: (phase) => {
          progress.push(phase);
        },
      });
      const request = captured()[0]!;
      assert.equal((request.body.req_params as { readonly speaker?: unknown }).speaker, "S_GuestVoice01");
      assert.match(progress[0]!, /S_GuestVoice01/u);
    },
  );
  // The default voice still answers a line that names none.
  assert.equal(resolveDoubaoSpeaker(dialogue), "S_NMb2Ke502");
  assert.equal(resolveDoubaoSpeaker(dialogue, " HOST "), "S_NMb2Ke502");
  assert.equal(resolveDoubaoSpeaker(dialogue, "S_Literal99"), "S_Literal99");
  assert.throws(() => resolveDoubaoSpeaker(dialogue, "NARRATOR"), /no voice named NARRATOR.*HOST, GUEST/u);
});

test("Doubao speech config reads a dialogue voice map and defaults to its first voice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doubao-tts-"));
  try {
    const path = join(directory, "dialogue.json");
    await writeFile(path, JSON.stringify({
      volc_tts: {
        api_key: "test-api-key",
        speakers: { L: "S_LeftVoice001", R: "S_RightVoice02" },
      },
    }), "utf8");
    const loaded = await readDoubaoSpeechConfig(path);
    assert.deepEqual(loaded.speakers, { L: "S_LeftVoice001", R: "S_RightVoice02" });
    assert.equal(loaded.speaker, "S_LeftVoice001");
    assert.equal(resolveDoubaoSpeaker(loaded, "R"), "S_RightVoice02");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gateway synthesis uses the tenant token, logical voice and stable idempotency key", async () => {
  const gatewayConfig: DoubaoSpeechConfig = {
    ...config,
    speaker: "旁白",
    resourceId: "hypit-gateway",
    gateway: {
      url: "https://gateway.example.com",
      token: "hgt_test_token",
      speaker: "旁白",
    },
  };
  await withFetch(
    () => new Response(new Uint8Array([7, 8, 9]), {
      status: 200,
      headers: {
        "x-hypit-task-id": "job_tts_1",
        "x-hypit-cost-fen": "3",
        "x-hypit-balance-fen": "997",
        "x-hypit-format": "mp3",
        "x-hypit-idempotent-replay": "0",
      },
    }),
    async (captured) => {
      const first = await synthesizeDoubaoSpeech({
        config: gatewayConfig,
        text: "同一句解说",
        speaker: "旁白",
      });
      const second = await synthesizeDoubaoSpeech({
        config: gatewayConfig,
        text: "同一句解说",
        speaker: "旁白",
      });
      assert.deepEqual([...first.audio], [7, 8, 9]);
      assert.equal(first.format, "mp3");
      assert.equal(first.requestId, "job_tts_1");
      assert.deepEqual(first.usage, {
        gateway: true,
        taskId: "job_tts_1",
        costFen: 3,
        balanceFen: 997,
        replay: false,
      });

      const requests = captured();
      assert.equal(requests.length, 2);
      assert.match(requests[0]!.url, /\/gateway\/v1\/tts$/u);
      assert.equal(requests[0]!.headers.get("authorization"), "Bearer hgt_test_token");
      assert.equal(requests[0]!.headers.get("idempotency-key"), requests[1]!.headers.get("idempotency-key"));
      assert.equal(requests[0]!.body.text, "同一句解说");
      assert.equal(requests[0]!.body.speaker, "旁白");
      assert.equal(second.audioMessages, 1);
    },
  );
});

test("gateway synthesis reports tenant errors without exposing the token", async () => {
  const gatewayConfig: DoubaoSpeechConfig = {
    ...config,
    speaker: "",
    resourceId: "hypit-gateway",
    gateway: {
      url: "https://gateway.example.com",
      token: "hgt_secret_token",
    },
  };
  await withFetch(
    () => new Response(JSON.stringify({
      code: "insufficient_balance",
      message: "Available balance is insufficient",
    }), { status: 402 }),
    async () => {
      await assert.rejects(
        synthesizeDoubaoSpeech({ config: gatewayConfig, text: "测试" }),
        (error: Error) => {
          assert.match(error.message, /HTTP 402/u);
          assert.match(error.message, /insufficient_balance/u);
          assert.match(error.message, /Available balance is insufficient/u);
          assert.equal(error.message.includes("hgt_secret_token"), false);
          return true;
        },
      );
    },
  );
});

test("gateway-only speech config does not require local Volc credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doubao-tts-"));
  try {
    const path = join(directory, "gateway.json");
    await writeFile(path, JSON.stringify({
      hypit_gateway: {
        enabled: true,
        url: "https://gateway.example.com/",
        token: "hgt_config_token",
        speaker: "旁白",
      },
    }), "utf8");
    const loaded = await readDoubaoSpeechConfig(path);
    assert.deepEqual(loaded.gateway, {
      url: "https://gateway.example.com",
      token: "hgt_config_token",
      speaker: "旁白",
    });
    assert.equal(loaded.apiKey, undefined);
    assert.equal(loaded.speaker, "旁白");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Doubao synthesis refuses an empty text instead of sending it", async () => {
  await assert.rejects(
    synthesizeDoubaoSpeech({ config, text: "   " }),
    /requires non-empty text/u,
  );
});

test("Doubao synthesis reports a stream that ends without audio", async () => {
  await withFetch(
    () => new Response(streamOf(`${JSON.stringify({ code: 20000000, message: "done" })}\n`, 5), { status: 200 }),
    async () => {
      await assert.rejects(
        synthesizeDoubaoSpeech({ config, text: "测试" }),
        /returned no audio for speaker S_NMb2Ke502/u,
      );
    },
  );
});

test("Doubao speech config reads volc_tts, expands the environment and defaults the product", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doubao-tts-"));
  const path = join(directory, "config.json");
  process.env.DOUBAO_TTS_TEST_KEY = "expanded-key";
  try {
    await writeFile(path, JSON.stringify({
      volc_tts: {
        api_key: "${DOUBAO_TTS_TEST_KEY}",
        speaker_id: "S_NMb2Ke502",
        speech_rate: -20,
      },
    }), "utf8");
    const loaded = await readDoubaoSpeechConfig(path);
    assert.equal(loaded.apiKey, "expanded-key");
    assert.equal(loaded.speaker, "S_NMb2Ke502");
    assert.equal(loaded.endpoint, "https://openspeech.bytedance.com");
    assert.equal(loaded.resourceId, "seed-icl-2.0");
    assert.equal(loaded.format, "mp3");
    assert.equal(loaded.sampleRate, 24_000);
    assert.equal(loaded.speechRate, -20);
  } finally {
    delete process.env.DOUBAO_TTS_TEST_KEY;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Doubao speech config rejects ambiguous credentials and a missing speaker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "doubao-tts-"));
  try {
    const ambiguous = join(directory, "ambiguous.json");
    await writeFile(ambiguous, JSON.stringify({
      volc_tts: { api_key: "a", app_id: "b", access_token: "c", speaker: "S_1" },
    }), "utf8");
    await assert.rejects(readDoubaoSpeechConfig(ambiguous), /not both/u);

    const missingSpeaker = join(directory, "missing-speaker.json");
    await writeFile(missingSpeaker, JSON.stringify({ volc_tts: { api_key: "a" } }), "utf8");
    await assert.rejects(readDoubaoSpeechConfig(missingSpeaker), /volc_tts\.speaker is required/u);

    const missingCredential = join(directory, "missing-credential.json");
    await writeFile(missingCredential, JSON.stringify({ volc_tts: { speaker: "S_1" } }), "utf8");
    await assert.rejects(readDoubaoSpeechConfig(missingCredential), /requires api_key/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

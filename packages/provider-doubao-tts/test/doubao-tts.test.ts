import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DoubaoSpeechConfig } from "../src/config.js";
import { readDoubaoSpeechConfig } from "../src/config.js";
import { synthesizeDoubaoSpeech } from "../src/speech.js";

const config: DoubaoSpeechConfig = {
  path: "test-config.json",
  endpoint: "https://openspeech.bytedance.com",
  resourceId: "seed-icl-2.0",
  speaker: "S_NMb2Ke502",
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

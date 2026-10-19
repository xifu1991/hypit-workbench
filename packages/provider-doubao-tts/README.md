# Volcengine Doubao TTS Provider

Local client for Volcengine Doubao speech synthesis on
`POST /api/v3/tts/unidirectional` (HTTP Chunked, V3). It speaks one piece of text in a
voice-clone speaker owned by the configured account and returns the assembled audio bytes.

The endpoint answers with newline-delimited JSON: every `code: 0` message carries one Base64
audio chunk and the final `code: 20000000` message ends the response. This client decodes that
stream across arbitrary transport boundaries, so a message split over two TCP reads is still one
chunk.

`resourceId` selects the product, and therefore the billing line:

| `resourceId` | Product |
| --- | --- |
| `seed-icl-2.0` | Voice clone (声音复刻) ICL 2.0 |
| `seed-icl-1.0` | Voice clone (声音复刻) ICL 1.0 |
| `seed-tts-2.0` | Doubao speech synthesis 2.0 without cloning |

Credentials and the speaker id stay in the local `config.json` selected by `configPath`; they are
never copied into Runtime receipts or browser payloads.

```json
{
  "volc_tts": {
    "api_key": "...",
    "endpoint": "https://openspeech.bytedance.com",
    "resource_id": "seed-icl-2.0",
    "speaker": "S_NMb2Ke502",
    "speakers": {
      "A": "S_NMb2Ke502",
      "B": "S_SecondVoice1"
    },
    "format": "mp3",
    "sample_rate": 24000
  }
}
```

## Platform gateway mode

When the tenant gateway is enabled, the client sends text to the gateway and never reads a local
Volcengine credential:

```json
{
  "hypit_gateway": {
    "enabled": true,
    "url": "https://gateway.example.com",
    "token": "hgt_...",
    "speaker": "旁白"
  }
}
```

`speaker` is the logical voice name assigned in the tenant console, not an `S_...` speaker id. A
per-line `speaker` overrides the default. Requests carry a deterministic `Idempotency-Key`, so
repeating the same text and voice reuses the completed gateway task instead of charging twice.

The returned headers supply the audio format, task id, cost and remaining balance. When
`hypit_gateway.enabled` is false or omitted, the direct `volc_tts` mode above remains unchanged.

## Two voices for dialogue

`volc_tts.speaker` is the default voice. `volc_tts.speakers` names additional console speaker ids,
so a caller can ask for a voice per line:

```ts
const config = await readDoubaoSpeechConfig("config.json");
await synthesizeDoubaoSpeech({ config, text: "你来解释一下。", speaker: "A" });
await synthesizeDoubaoSpeech({ config, text: "我试试。", speaker: "B" });
```

`resolveDoubaoSpeaker(config, name)` turns a name into the console id, accepts a literal `S_...` id
for one-off probes, and reports the configured names when the requested one is unknown. Omitting the
name keeps the default voice. Every named voice must live on the account behind `api_key` and be
covered by the synthesis product in `resource_id`; mixing voices from different accounts needs a
separate config and credential.

The account behind `api_key` must own the speaker **and** have the matching synthesis product
enabled. A voice that can be listed by `get_voice` is not by itself synthesizable: without the
product grant the endpoint answers HTTP 403 `45000030 requested resource not granted`, which this
client reports as an actionable failure rather than an empty file.

This package is a library. The project-level narration entry point lives in the authoring
workspace (`scripts/narration-doubao.ts`), which resolves its config through `readDoubaoSpeechConfig`.

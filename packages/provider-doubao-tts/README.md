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
    "format": "mp3",
    "sample_rate": 24000
  }
}
```

The account behind `api_key` must own the speaker **and** have the matching synthesis product
enabled. A voice that can be listed by `get_voice` is not by itself synthesizable: without the
product grant the endpoint answers HTTP 403 `45000030 requested resource not granted`, which this
client reports as an actionable failure rather than an empty file.

This package is a library. The project-level narration entry point lives in the authoring
workspace (`scripts/narration-doubao.ts`), which resolves its config through `readDoubaoSpeechConfig`.

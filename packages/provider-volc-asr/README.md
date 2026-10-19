# Volcengine Doubao ASR Provider

This local Runtime endpoint fulfills Hypit's word-level speech alignment capability with
Volcengine Doubao recording-file recognition 2.0.

The Provider:

1. Receives the normalized 16 kHz mono WAV already produced by Hypit.
2. Uploads it temporarily to the configured Volcengine TOS bucket.
3. Calls `volc.seedasr.auc` with word timestamps enabled.
4. Converts the response into Hypit `AlignedTranscriptEvidence`.
5. Deletes the temporary TOS object after success or failure.

Credentials stay in the local `config.json` selected by `configPath`; they are never copied into
Runtime receipts or browser payloads.

## Platform gateway mode

An account can use the tenant gateway instead of local ASR and TOS credentials:

```json
{
  "hypit_gateway": {
    "enabled": true,
    "url": "https://gateway.example.com",
    "token": "hgt_..."
  }
}
```

In this mode the Provider uploads the normalized WAV directly to `/gateway/v1/asr`. The gateway
owns the temporary TOS object and returns the Doubao transcript; no `volc_asr` or `volc_tos`
credentials are required locally. The audio digest supplies a deterministic `Idempotency-Key`.
When the gateway is not enabled, the direct Volcengine mode above is used unchanged.

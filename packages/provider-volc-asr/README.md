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

import assert from "node:assert/strict";
import test from "node:test";

import { interpretVolcTranscript } from "../src/evidence.js";

test("Doubao millisecond responses become exact 16 kHz evidence samples", () => {
  const evidence = interpretVolcTranscript({
    result: {
      utterances: [{
        text: "hello world",
        start_time: 100,
        end_time: 1_600,
        words: [
          { text: "hello", start_time: 100, end_time: 700 },
          { text: "world", start_time: 900, end_time: 1_600 },
        ],
      }],
    },
  }, 32_000);

  assert.deepEqual(evidence, {
    passages: [{
      startSample: 1_600,
      endSampleExclusive: 25_600,
      words: [
        { text: "hello", startSample: 1_600, endSampleExclusive: 11_200 },
        { text: "world", startSample: 14_400, endSampleExclusive: 25_600 },
      ],
      chars: [],
      speechActivity: [{ startSample: 1_600, endSampleExclusive: 25_600 }],
    }],
  });
});

test("second-based transcript fields remain usable and out-of-range timing stays non-blocking", () => {
  const evidence = interpretVolcTranscript({
    utterances: [{
      text: "one sentence",
      start: 0.25,
      end: 1.25,
      words: [
        { text: "one", start: 0.25, end: 0.75 },
        { text: "outside", start: 2, end: 3 },
      ],
    }],
  }, 32_000);

  assert.deepEqual(evidence.passages[0]?.words, [
    { text: "one", startSample: 4_000, endSampleExclusive: 12_000 },
    { text: "outside" },
  ]);
  assert.deepEqual(evidence.passages[0]?.speechActivity, [
    { startSample: 4_000, endSampleExclusive: 20_000 },
  ]);
});

test("Doubao responses without word-level timing are rejected", () => {
  assert.throws(
    () => interpretVolcTranscript({ result: { utterances: [] } }, 16_000),
    /no word-level transcript/u,
  );
});

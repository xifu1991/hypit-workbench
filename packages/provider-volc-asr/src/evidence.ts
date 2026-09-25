import type { AlignedTranscriptEvidence, SpeechTranscriptPassage } from "@hypit/speech-evidence";

type RawWord = {
  readonly text?: unknown;
  readonly start_time?: unknown;
  readonly end_time?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
};

type RawUtterance = {
  readonly text?: unknown;
  readonly start_time?: unknown;
  readonly end_time?: unknown;
  readonly start?: unknown;
  readonly end?: unknown;
  readonly words?: unknown;
  readonly additions?: unknown;
};

export type VolcTranscriptResponse = {
  readonly result?: unknown;
  readonly utterances?: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function millisecondsAsSeconds(value: unknown): number | undefined {
  return finite(value) && value >= 0 ? value / 1000 : undefined;
}

function seconds(value: unknown): number | undefined {
  return finite(value) && value >= 0 ? value : undefined;
}

function timeWindow(raw: RawWord | RawUtterance): {
  readonly startSeconds: number | undefined;
  readonly endSeconds: number | undefined;
} {
  return {
    startSeconds: millisecondsAsSeconds(raw.start_time) ?? seconds(raw.start),
    endSeconds: millisecondsAsSeconds(raw.end_time) ?? seconds(raw.end),
  };
}

function sampleWindow(
  startSeconds: number | undefined,
  endSeconds: number | undefined,
  sampleFrames: number,
): { readonly startSample: number; readonly endSampleExclusive: number } | undefined {
  if (startSeconds === undefined || endSeconds === undefined || endSeconds < startSeconds) return undefined;
  const startSample = Math.round(startSeconds * 16_000);
  const endSampleExclusive = Math.round(endSeconds * 16_000);
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSampleExclusive)
    || startSample < 0 || endSampleExclusive > sampleFrames) return undefined;
  return { startSample, endSampleExclusive };
}

type SpeechWord = SpeechTranscriptPassage["words"][number];

function words(value: unknown, sampleFrames: number): SpeechWord[] {
  if (value === undefined) return [];
  assert(Array.isArray(value), "Volc ASR words must be an array");
  const result: SpeechWord[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as RawWord;
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (text.length === 0) continue;
    const timing = timeWindow(raw);
    const window = sampleWindow(timing.startSeconds, timing.endSeconds, sampleFrames);
    result.push({ text, ...(window === undefined ? {} : window) });
  }
  return result;
}

/** Convert Doubao recording-file ASR output into Hypit's provider-neutral evidence. */
export function interpretVolcTranscript(
  response: VolcTranscriptResponse,
  sampleFrames: number,
): AlignedTranscriptEvidence {
  assert(Number.isSafeInteger(sampleFrames) && sampleFrames > 0,
    "Volc ASR evidence sample count must be a positive integer");
  const result = response.result !== undefined && response.result !== null
    && typeof response.result === "object" && !Array.isArray(response.result)
    ? response.result as Record<string, unknown>
    : response;
  const utterances = result.utterances ?? response.utterances;
  assert(Array.isArray(utterances), "Volc ASR response has no utterances");

  const passages: SpeechTranscriptPassage[] = [];
  for (const item of utterances) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as RawUtterance;
    const alignedWords = words(raw.words, sampleFrames);
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    const timing = timeWindow(raw);
    if (alignedWords.length === 0 && text.length > 0) {
      const window = sampleWindow(timing.startSeconds, timing.endSeconds, sampleFrames);
      alignedWords.push({ text, ...(window === undefined ? {} : window) });
    }
    if (alignedWords.length === 0) continue;
    const window = sampleWindow(timing.startSeconds, timing.endSeconds, sampleFrames);
    const first = alignedWords.find((word) => word.startSample !== undefined);
    const last = [...alignedWords].reverse().find((word) => word.endSampleExclusive !== undefined);
    const passage = {
      ...(window === undefined
        ? {
            ...(first?.startSample === undefined ? {} : { startSample: first.startSample }),
            ...(last?.endSampleExclusive === undefined ? {} : { endSampleExclusive: last.endSampleExclusive }),
          }
        : window),
      words: alignedWords,
      chars: [],
      ...(window === undefined ? {} : { speechActivity: [window] }),
    } satisfies SpeechTranscriptPassage;
    passages.push(passage);
  }
  const wordsCount = passages.reduce((count, passage) => count + passage.words.length, 0);
  assert(wordsCount > 0, "Volc ASR returned no word-level transcript");
  return { passages };
}

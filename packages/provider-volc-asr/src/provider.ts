import { sealAlignedTranscriptEvidence, speechEvidenceTypes } from "@hypit/speech-evidence";
import type { EndpointInvocationContext } from "@hypit/endpoint-kit";
import { canonicalize } from "@hypit/protocol";
import { defineEndpointPackage } from "@hypit/endpoint-kit";
import {
  assertWhisperXEvidenceWav,
  verifyWhisperXAlignmentRequest,
  whisperXCapabilities,
} from "@hypit/whisperx";

import type { VolcConfig } from "./config.js";
import { interpretVolcTranscript } from "./evidence.js";
import { transcribeVolc } from "./volc-asr.js";

export const volcAsrProviderModuleRef = {
  name: "@hypit/provider-volc-asr",
  version: "1",
} as const;

export type CreateVolcAsrProviderOptions = {
  readonly instance: string;
  readonly pool: string;
  readonly config: VolcConfig;
  readonly defaultConcurrency?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly deleteTemporaryObject?: boolean;
  readonly temporaryObjectPrefix?: string;
  readonly presignExpiresSeconds?: number;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function createVolcAsrProvider(options: CreateVolcAsrProviderOptions) {
  return defineEndpointPackage({
    module: volcAsrProviderModuleRef,
    facet: "alignment",
    instance: options.instance,
    pool: options.pool,
    defaultConcurrency: options.defaultConcurrency ?? 1,
    capabilities: [{
      lifecycle: "immediate" as const,
      capability: whisperXCapabilities.alignment,
      returns: speechEvidenceTypes.alignedTranscript,
      handler: async (context: EndpointInvocationContext) => {
        const request = verifyWhisperXAlignmentRequest(context.need.constraints);
        const audio = await context.resources.get(request.audio.resource);
        assert(audio !== undefined && audio.byteLength === request.audio.size,
          `Speech evidence Artifact ${request.audio.resource} is unavailable or has changed`);
        assertWhisperXEvidenceWav(audio, request.sampleFrames);
        const transcript = await transcribeVolc({
          config: options.config,
          audio,
          requestTimeoutMs: options.requestTimeoutMs ?? 10 * 60_000,
          maxResponseBytes: options.maxResponseBytes ?? 32 * 1024 * 1024,
          deleteTemporaryObject: options.deleteTemporaryObject ?? true,
          temporaryObjectPrefix: options.temporaryObjectPrefix ?? "hypit-volc-asr",
          presignExpiresSeconds: options.presignExpiresSeconds ?? 3_600,
          ...(context.reportProgress === undefined
            ? {}
            : { reportProgress: (phase: string) => context.reportProgress!({ phase }) }),
          ...(context.reportDiagnostic === undefined
            ? {}
            : {
                reportDiagnostic: (level: "info" | "warning" | "error", message: string) =>
                  context.reportDiagnostic!({ level, message, stream: "stdout" }),
              }),
        });
        const evidence = sealAlignedTranscriptEvidence(
          interpretVolcTranscript(transcript, request.sampleFrames),
        );
        return { value: { kind: "inline", value: canonicalize(evidence) } };
      },
    }],
  });
}

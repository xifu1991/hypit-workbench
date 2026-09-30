import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Plugin } from "vite";
import { createStyleLibrary } from "@hypit/style-library";
import {
  recommendStylePlan,
  type StylePlanDocument,
  type StyleTimedWords,
} from "./style-recommender.js";

export type StudioStyleLibraryOptions = {
  readonly root: string;
  readonly workspaceRoot: string;
};

type StyleSelectionEntry = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly preview: string;
};

type StyleSelectionDocument = {
  readonly format: "hypit.style-selection@1";
  readonly updatedAt: string | null;
  readonly styles: readonly StyleSelectionEntry[];
};

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

function assetUrl(origin: URL, id: string, version: string, asset: string): string {
  const query = new URLSearchParams({ asset, id, version });
  return `/__studio/style-library/asset?${query.toString()}`;
}

function range(value: string | undefined, size: number): { readonly start: number; readonly end: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1]!.length === 0 && match[2]!.length === 0) || size === 0) {
    throw new RangeError("requested byte range is not satisfiable");
  }
  if (match[1]!.length === 0) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("requested byte range is not satisfiable");
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2]!.length === 0 ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || start >= size || requestedEnd < start) {
    throw new RangeError("requested byte range is not satisfiable");
  }
  return { start, end: Math.min(size - 1, requestedEnd) };
}

function selectionDocument(value: unknown): StyleSelectionDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Style selection must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.format !== "hypit.style-selection@1" || !Array.isArray(raw.styles)) {
    throw new Error("Style selection has an unsupported format.");
  }
  const styles = raw.styles.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Style selection entry ${index} is invalid.`);
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.name !== "string"
      || typeof entry.version !== "string" || typeof entry.preview !== "string") {
      throw new Error(`Style selection entry ${index} is incomplete.`);
    }
    return {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      preview: entry.preview,
    } satisfies StyleSelectionEntry;
  });
  if (raw.updatedAt !== null && typeof raw.updatedAt !== "string") {
    throw new Error("Style selection updatedAt is invalid.");
  }
  return { format: "hypit.style-selection@1", updatedAt: raw.updatedAt, styles };
}

function selectionIds(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Style selection request must be an object.");
  }
  const ids = (value as Record<string, unknown>).ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(id))) {
    throw new Error("Style selection ids are invalid.");
  }
  return [...new Set(ids as string[])];
}

function recommendationRequest(value: unknown): {
  readonly words: readonly StyleTimedWords[];
  readonly durationSec: number;
  readonly candidateIds?: readonly string[];
  readonly sourceRevision?: number;
  readonly sourcePath?: string;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Style recommendation request must be an object.");
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.words) || raw.words.length > 5_000
    || typeof raw.durationSec !== "number" || !Number.isFinite(raw.durationSec) || raw.durationSec <= 0) {
    throw new Error("Style recommendation input is invalid.");
  }
  const words = raw.words.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Style recommendation word ${index} is invalid.`);
    }
    const word = item as Record<string, unknown>;
    if (typeof word.text !== "string" || word.text.length > 240
      || typeof word.startSec !== "number" || !Number.isFinite(word.startSec) || word.startSec < 0
      || typeof word.endSec !== "number" || !Number.isFinite(word.endSec) || word.endSec < word.startSec) {
      throw new Error(`Style recommendation word ${index} is invalid.`);
    }
    return { text: word.text, startSec: word.startSec, endSec: word.endSec } satisfies StyleTimedWords;
  });
  let candidateIds: readonly string[] | undefined;
  if (raw.candidateIds !== undefined) {
    if (!Array.isArray(raw.candidateIds)
      || raw.candidateIds.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(id))) {
      throw new Error("Style recommendation candidate ids are invalid.");
    }
    candidateIds = [...new Set(raw.candidateIds as string[])];
  }
  if (raw.sourceRevision !== undefined
    && (typeof raw.sourceRevision !== "number" || !Number.isSafeInteger(raw.sourceRevision) || raw.sourceRevision < 0)) {
    throw new Error("Style recommendation source revision is invalid.");
  }
  if (raw.sourcePath !== undefined && (typeof raw.sourcePath !== "string" || raw.sourcePath.length > 2_000)) {
    throw new Error("Style recommendation source path is invalid.");
  }
  return {
    words,
    durationSec: raw.durationSec,
    ...(candidateIds === undefined ? {} : { candidateIds }),
    ...(raw.sourceRevision === undefined ? {} : { sourceRevision: raw.sourceRevision }),
    ...(raw.sourcePath === undefined ? {} : { sourcePath: raw.sourcePath }),
  };
}

function stylePlanDocument(value: unknown): StylePlanDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Style plan must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const windowRange = raw.windowRangeSec;
  if (raw.format !== "hypit.style-plan@1"
    || typeof raw.durationSec !== "number" || !Number.isFinite(raw.durationSec) || raw.durationSec <= 0
    || windowRange === null || typeof windowRange !== "object" || Array.isArray(windowRange)
    || !Array.isArray(raw.windows)) {
    throw new Error("Style plan has an unsupported format.");
  }
  const range = windowRange as Record<string, unknown>;
  if (typeof range.min !== "number" || typeof range.max !== "number") {
    throw new Error("Style plan window range is invalid.");
  }
  const windows = raw.windows.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Style plan window ${index} is invalid.`);
    }
    const window = item as Record<string, unknown>;
    if (typeof window.index !== "number" || !Number.isSafeInteger(window.index)
      || typeof window.startSec !== "number" || !Number.isFinite(window.startSec) || window.startSec < 0
      || typeof window.endSec !== "number" || !Number.isFinite(window.endSec) || window.endSec <= window.startSec
      || typeof window.styleId !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(window.styleId)
      || typeof window.styleName !== "string"
      || typeof window.confidence !== "number" || !Number.isFinite(window.confidence)
      || typeof window.reason !== "string"
      || !Array.isArray(window.matchedTerms) || window.matchedTerms.some((term) => typeof term !== "string")
      || typeof window.text !== "string") {
      throw new Error(`Style plan window ${index} is invalid.`);
    }
    return {
      index: window.index,
      startSec: window.startSec,
      endSec: window.endSec,
      styleId: window.styleId,
      styleName: window.styleName,
      confidence: window.confidence,
      reason: window.reason,
      matchedTerms: window.matchedTerms as string[],
      text: window.text,
    };
  });
  if (raw.updatedAt !== null && typeof raw.updatedAt !== "string") {
    throw new Error("Style plan updatedAt is invalid.");
  }
  if (raw.sourceRevision !== undefined && (typeof raw.sourceRevision !== "number" || !Number.isSafeInteger(raw.sourceRevision))) {
    throw new Error("Style plan source revision is invalid.");
  }
  if (raw.sourcePath !== undefined && typeof raw.sourcePath !== "string") {
    throw new Error("Style plan source path is invalid.");
  }
  return {
    format: "hypit.style-plan@1",
    updatedAt: raw.updatedAt,
    durationSec: raw.durationSec,
    windowRangeSec: { min: range.min, max: range.max },
    ...(raw.sourceRevision === undefined ? {} : { sourceRevision: raw.sourceRevision }),
    ...(raw.sourcePath === undefined ? {} : { sourcePath: raw.sourcePath }),
    windows,
  };
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function studioStyleLibraryPlugin(options: StudioStyleLibraryOptions): Plugin {
  const library = createStyleLibrary(options.root);
  const selectionPath = join(options.workspaceRoot, "HYPIT_STYLE_SELECTION.json");
  const planPath = join(options.workspaceRoot, "HYPIT_STYLE_PLAN.json");
  const writeAtomic = async (path: string, value: unknown): Promise<void> => {
    const temporary = join(options.workspaceRoot, `.${path.split(/[\\/]/u).at(-1)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  };
  const readSelection = async (): Promise<StyleSelectionDocument> => {
    try {
      return selectionDocument(JSON.parse(await readFile(selectionPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { format: "hypit.style-selection@1", updatedAt: null, styles: [] };
      }
      throw error;
    }
  };
  const writeSelection = async (document: StyleSelectionDocument): Promise<void> => {
    await writeAtomic(selectionPath, document);
  };
  const readPlan = async (): Promise<StylePlanDocument | undefined> => {
    try {
      return stylePlanDocument(JSON.parse(await readFile(planPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const selectionEntries = async (ids: readonly string[]): Promise<readonly StyleSelectionEntry[]> => {
    const entries = await library.list();
    return ids.map((id) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (entry === undefined) throw new Error(`Style ${id} does not exist.`);
      return {
        id: entry.id,
        name: entry.name,
        version: entry.latestVersion,
        preview: entry.preview,
      } satisfies StyleSelectionEntry;
    });
  };
  return {
    name: "hypit-studio-style-library",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://studio.hypit.local");
        if (url.pathname === "/__studio/style-library") {
          void library.list().then(
            (styles) => json(response, 200, {
              root: library.root,
              styles: styles.map((entry) => ({
                ...entry,
                preview: assetUrl(url, entry.id, entry.latestVersion, "preview"),
              })),
            }),
            (error) => json(response, 500, { error: error instanceof Error ? error.message : String(error) }),
          );
          return;
        }
        if (url.pathname === "/__studio/style-library/selection") {
          void (async () => {
            try {
              if (request.method === "GET") {
                json(response, 200, await readSelection());
                return;
              }
              if (request.method !== "PUT") {
                response.statusCode = 405;
                response.end();
                return;
              }
              const ids = selectionIds(await readRequestBody(request));
              const selected = await selectionEntries(ids);
              const document: StyleSelectionDocument = {
                format: "hypit.style-selection@1",
                updatedAt: new Date().toISOString(),
                styles: selected,
              };
              await writeSelection(document);
              json(response, 200, document);
            } catch (error) {
              json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }
        if (url.pathname === "/__studio/style-library/plan") {
          void readPlan().then(
            (plan) => json(response, 200, plan ?? null),
            (error) => json(response, 500, { error: error instanceof Error ? error.message : String(error) }),
          );
          return;
        }
        if (url.pathname === "/__studio/style-library/recommend") {
          void (async () => {
            try {
              if (request.method !== "POST") {
                response.statusCode = 405;
                response.end();
                return;
              }
              const input = recommendationRequest(await readRequestBody(request));
              const entries = await library.list();
              const plan = recommendStylePlan(entries, input.words, input.durationSec, {
                ...(input.candidateIds === undefined ? {} : { candidateIds: input.candidateIds }),
                ...(input.sourceRevision === undefined ? {} : { sourceRevision: input.sourceRevision }),
                ...(input.sourcePath === undefined ? {} : { sourcePath: input.sourcePath }),
              });
              const usedIds = [...new Set(plan.windows.map((window) => window.styleId))];
              const selected = await selectionEntries(usedIds);
              const selection: StyleSelectionDocument = {
                format: "hypit.style-selection@1",
                updatedAt: new Date().toISOString(),
                styles: selected,
              };
              await Promise.all([
                writeAtomic(planPath, plan),
                writeSelection(selection),
              ]);
              json(response, 200, { plan, selection });
            } catch (error) {
              json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }
        if (url.pathname === "/__studio/style-library/detail") {
          const id = url.searchParams.get("id");
          const version = url.searchParams.get("version") ?? undefined;
          if (id === null) {
            json(response, 400, { error: "Choose a style id." });
            return;
          }
          void library.detail(id, version).then((detail) => {
            const selectedVersion = detail.metadata.version;
            json(response, 200, {
              ...detail,
              assets: {
                preview: assetUrl(url, id, selectedVersion, "preview"),
                evidence: detail.metadata.analysis.evidence.map((_path, index) =>
                  assetUrl(url, id, selectedVersion, `evidence:${index}`)),
                source: assetUrl(url, id, selectedVersion, "source"),
                transcript: assetUrl(url, id, selectedVersion, "transcript"),
              },
            });
          }, (error) => json(response, 500, { error: error instanceof Error ? error.message : String(error) }));
          return;
        }
        if (url.pathname === "/__studio/style-library/asset") {
          const id = url.searchParams.get("id");
          const version = url.searchParams.get("version");
          const asset = url.searchParams.get("asset");
          if (id === null || version === null || asset === null) {
            json(response, 400, { error: "Expected style id, version and asset." });
            return;
          }
          void library.asset(id, version, asset).then(async (selected) => {
            if (selected === undefined) {
              response.statusCode = 404;
              response.end();
              return;
            }
            const bytes = await readFile(selected.path);
            let selectedRange: { readonly start: number; readonly end: number } | undefined;
            try {
              selectedRange = range(request.headers.range, bytes.byteLength);
            } catch (error) {
              if (!(error instanceof RangeError)) throw error;
              response.statusCode = 416;
              response.setHeader("content-range", `bytes */${bytes.byteLength}`);
              response.end();
              return;
            }
            response.statusCode = selectedRange === undefined ? 200 : 206;
            response.setHeader("content-type", selected.mediaType);
            response.setHeader("cache-control", "private, max-age=300");
            response.setHeader("accept-ranges", "bytes");
            if (selectedRange === undefined) {
              response.setHeader("content-length", String(bytes.byteLength));
              if (request.method === "HEAD") response.end();
              else response.end(bytes);
              return;
            }
            const body = bytes.subarray(selectedRange.start, selectedRange.end + 1);
            response.setHeader("content-length", String(body.byteLength));
            response.setHeader("content-range", `bytes ${selectedRange.start}-${selectedRange.end}/${bytes.byteLength}`);
            if (request.method === "HEAD") response.end();
            else response.end(body);
          }).catch((error) => {
            if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
            else json(response, 500, { error: error instanceof Error ? error.message : String(error) });
          });
          return;
        }
        next();
      });
    },
  };
}

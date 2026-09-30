import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";

import type { Plugin } from "vite";
import {
  normalizeStickerTags,
  normalizeStickerTextMode,
  parseStickerLibrary,
  recommendStickers,
  stickerLibraryFormat,
  type StickerLibraryDocument,
  type StickerLibraryEntry,
  type StickerPlacement,
  type StickerTextMode,
  type StickerTimedWord,
} from "./sticker-library.js";

export type StudioStickerLibraryOptions = {
  readonly root: string;
  readonly workspaceRoot: string;
};

type StickerSelectionEntry = {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly mediaType: string;
  readonly textMode: StickerTextMode;
  readonly tags: readonly string[];
  readonly suggestedText?: string;
  readonly placement?: StickerPlacement;
};

type StickerSelectionDocument = {
  readonly format: "hypit.sticker-selection@1";
  readonly updatedAt: string | null;
  readonly stickers: readonly StickerSelectionEntry[];
};

const maxUploadBytes = 25 * 1024 * 1024;
const extensions = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
  ["image/svg+xml", ".svg"],
  ["video/webm", ".webm"],
]);

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

function assetUrl(id: string): string {
  return `/__studio/sticker-library/asset?id=${encodeURIComponent(id)}`;
}

function byteRange(value: string | undefined, size: number): { readonly start: number; readonly end: number } | undefined {
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

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function requestObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function placement(value: unknown): StickerPlacement | undefined {
  if (value === undefined) return undefined;
  const raw = requestObject(value, "Sticker placement");
  const anchors = new Set<StickerPlacement["anchor"]>([
    "top-left", "top-center", "top-right",
    "center-left", "center", "center-right",
    "bottom-left", "bottom-center", "bottom-right",
  ]);
  if (typeof raw.startSec !== "number" || !Number.isFinite(raw.startSec) || raw.startSec < 0
    || typeof raw.endSec !== "number" || !Number.isFinite(raw.endSec) || raw.endSec <= raw.startSec
    || typeof raw.xPercent !== "number" || !Number.isFinite(raw.xPercent)
    || typeof raw.yPercent !== "number" || !Number.isFinite(raw.yPercent)
    || typeof raw.scale !== "number" || !Number.isFinite(raw.scale) || raw.scale <= 0
    || typeof raw.anchor !== "string" || !anchors.has(raw.anchor as StickerPlacement["anchor"])) {
    throw new Error("Sticker placement is invalid.");
  }
  return {
    startSec: raw.startSec,
    endSec: raw.endSec,
    xPercent: raw.xPercent,
    yPercent: raw.yPercent,
    scale: raw.scale,
    anchor: raw.anchor as StickerPlacement["anchor"],
  };
}

function selectionDocument(value: unknown): StickerSelectionDocument {
  const raw = requestObject(value, "Sticker selection");
  if (raw.format !== "hypit.sticker-selection@1" || !Array.isArray(raw.stickers)
    || (raw.updatedAt !== null && typeof raw.updatedAt !== "string")) {
    throw new Error("Sticker selection has an unsupported format.");
  }
  const stickers = raw.stickers.map((item, index) => {
    const entry = requestObject(item, `Sticker selection entry ${index}`);
    if (typeof entry.id !== "string" || typeof entry.name !== "string"
      || typeof entry.file !== "string" || typeof entry.mediaType !== "string"
      || !Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string")) {
      throw new Error(`Sticker selection entry ${index} is invalid.`);
    }
    const textMode = normalizeStickerTextMode(entry.textMode);
    const suggestedText = typeof entry.suggestedText === "string" && entry.suggestedText.trim().length > 0
      ? entry.suggestedText.trim().slice(0, 120)
      : undefined;
    const selectedPlacement = placement(entry.placement);
    return {
      id: entry.id,
      name: entry.name,
      file: entry.file,
      mediaType: entry.mediaType,
      textMode,
      tags: entry.tags as string[],
      ...(suggestedText === undefined ? {} : { suggestedText }),
      ...(selectedPlacement === undefined ? {} : { placement: selectedPlacement }),
    } satisfies StickerSelectionEntry;
  });
  return { format: "hypit.sticker-selection@1", updatedAt: raw.updatedAt, stickers };
}

function selectionRequest(value: unknown): {
  readonly ids: readonly string[];
  readonly placements: ReadonlyMap<string, StickerPlacement>;
  readonly suggestedTexts: ReadonlyMap<string, string>;
} {
  const raw = requestObject(value, "Sticker selection request");
  if (!Array.isArray(raw.ids) || raw.ids.some((id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(id))) {
    throw new Error("Sticker selection ids are invalid.");
  }
  const placements = new Map<string, StickerPlacement>();
  if (raw.placements !== undefined) {
    const values = requestObject(raw.placements, "Sticker placements");
    for (const [id, value] of Object.entries(values)) {
      const selectedPlacement = placement(value);
      if (selectedPlacement !== undefined) placements.set(id, selectedPlacement);
    }
  }
  const suggestedTexts = new Map<string, string>();
  if (raw.suggestedTexts !== undefined) {
    const values = requestObject(raw.suggestedTexts, "Sticker suggested text");
    for (const [id, value] of Object.entries(values)) {
      if (typeof value === "string" && value.trim().length > 0) {
        suggestedTexts.set(id, value.trim().slice(0, 120));
      }
    }
  }
  return { ids: [...new Set(raw.ids as string[])], placements, suggestedTexts };
}

function recommendationRequest(value: unknown): { readonly words: readonly StickerTimedWord[]; readonly durationSec: number } {
  const raw = requestObject(value, "Sticker recommendation request");
  if (!Array.isArray(raw.words) || raw.words.length > 5_000
    || typeof raw.durationSec !== "number" || !Number.isFinite(raw.durationSec) || raw.durationSec <= 0) {
    throw new Error("Sticker recommendation input is invalid.");
  }
  const words = raw.words.map((item, index) => {
    const word = requestObject(item, `Sticker word ${index}`);
    if (typeof word.text !== "string" || word.text.length > 200
      || typeof word.startSec !== "number" || !Number.isFinite(word.startSec) || word.startSec < 0
      || typeof word.endSec !== "number" || !Number.isFinite(word.endSec) || word.endSec < word.startSec) {
      throw new Error(`Sticker word ${index} is invalid.`);
    }
    return { text: word.text, startSec: word.startSec, endSec: word.endSec } satisfies StickerTimedWord;
  });
  return { words, durationSec: raw.durationSec };
}

function uploadFile(value: FormDataEntryValue | null): File {
  if (value === null || typeof value === "string") throw new Error("Choose a sticker file to upload.");
  if (!extensions.has(value.type)) throw new Error(`Unsupported sticker format: ${value.type || "unknown"}.`);
  if (value.size > maxUploadBytes) throw new Error("Sticker files must be 25 MB or smaller.");
  return value;
}

async function multipartForm(request: import("node:http").IncomingMessage): Promise<FormData> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const parsed = new Request("http://studio.hypit.local/__studio/sticker-library", {
    method: "POST",
    headers,
    body: Readable.toWeb(request),
    duplex: "half",
  } as RequestInit & { readonly duplex: "half" });
  return parsed.formData();
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export function studioStickerLibraryPlugin(options: StudioStickerLibraryOptions): Plugin {
  const root = resolve(options.root);
  const indexPath = join(root, "index.json");
  const selectionPath = join(options.workspaceRoot, "HYPIT_STICKER_SELECTION.json");

  const readLibrary = async (): Promise<StickerLibraryDocument> => {
    try {
      return parseStickerLibrary(JSON.parse(await readFile(indexPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { format: stickerLibraryFormat, updatedAt: null, stickers: [] };
      }
      throw error;
    }
  };

  const writeAtomic = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temporary, path);
    } finally {
      await removeIfPresent(temporary);
    }
  };

  const readSelection = async (): Promise<StickerSelectionDocument> => {
    try {
      return selectionDocument(JSON.parse(await readFile(selectionPath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { format: "hypit.sticker-selection@1", updatedAt: null, stickers: [] };
      }
      throw error;
    }
  };

  const assetPath = async (id: string): Promise<string | undefined> => {
    const entry = (await readLibrary()).stickers.find((candidate) => candidate.id === id);
    if (entry === undefined) return undefined;
    const path = resolve(root, entry.file);
    const contained = relative(root, path);
    if (contained.startsWith("..") || isAbsolute(contained)) return undefined;
    return path;
  };

  return {
    name: "hypit-studio-sticker-library",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://studio.hypit.local");
        if (url.pathname === "/__studio/sticker-library") {
          void (async () => {
            try {
              if (request.method === "GET") {
                const library = await readLibrary();
                json(response, 200, {
                  root,
                  stickers: library.stickers.map((entry) => ({ ...entry, url: assetUrl(entry.id) })),
                });
                return;
              }
              if (request.method === "POST") {
                const form = await multipartForm(request);
                const file = uploadFile(form.get("file"));
                const extension = extensions.get(file.type)!;
                const id = `sticker-${randomUUID().slice(0, 8)}`;
                const nameValue = form.get("name");
                const name = typeof nameValue === "string" && nameValue.trim().length > 0
                  ? nameValue.trim().slice(0, 80)
                  : basename(file.name, extname(file.name)).trim().slice(0, 80) || "Sticker";
                const tags = normalizeStickerTags(form.get("tags"));
                const textMode = normalizeStickerTextMode(form.get("textMode"));
                const filePath = `stickers/${id}${extension}`;
                const target = join(root, filePath);
                const bytes = Buffer.from(await file.arrayBuffer());
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, bytes, { flag: "wx" });
                try {
                  const library = await readLibrary();
                  const entry: StickerLibraryEntry = {
                    id,
                    name,
                    kind: file.type === "video/webm" || file.type === "image/gif" ? "animated" : "static",
                    file: filePath,
                    mediaType: file.type,
                    textMode,
                    tags,
                    createdAt: new Date().toISOString(),
                    size: bytes.byteLength,
                  };
                  await writeAtomic(indexPath, {
                    format: stickerLibraryFormat,
                    updatedAt: new Date().toISOString(),
                    stickers: [...library.stickers, entry],
                  });
                  json(response, 201, { ...entry, url: assetUrl(entry.id) });
                } catch (error) {
                  await removeIfPresent(target);
                  throw error;
                }
                return;
              }
              response.statusCode = 405;
              response.end();
            } catch (error) {
              json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }

        if (url.pathname === "/__studio/sticker-library/metadata") {
          void (async () => {
            try {
              if (request.method !== "PUT") {
                response.statusCode = 405;
                response.end();
                return;
              }
              const raw = requestObject(await readJson(request), "Sticker metadata");
              if (typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(raw.id)) {
                throw new Error("Sticker id is invalid.");
              }
              const library = await readLibrary();
              const current = library.stickers.find((entry) => entry.id === raw.id);
              if (current === undefined) throw new Error(`Sticker ${raw.id} does not exist.`);
              const name = raw.name === undefined ? current.name
                : typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name.trim().slice(0, 80)
                  : (() => { throw new Error("Sticker name is invalid."); })();
              const tags = raw.tags === undefined ? current.tags : normalizeStickerTags(raw.tags);
              const textMode = raw.textMode === undefined ? current.textMode : normalizeStickerTextMode(raw.textMode);
              const updated: StickerLibraryEntry = { ...current, name, tags, textMode };
              await writeAtomic(indexPath, {
                format: stickerLibraryFormat,
                updatedAt: new Date().toISOString(),
                stickers: library.stickers.map((entry) => entry.id === updated.id ? updated : entry),
              });
              json(response, 200, { ...updated, url: assetUrl(updated.id) });
            } catch (error) {
              json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }

        if (url.pathname === "/__studio/sticker-library/recommend") {
          void (async () => {
            try {
              if (request.method !== "POST") {
                response.statusCode = 405;
                response.end();
                return;
              }
              const input = recommendationRequest(await readJson(request));
              const library = await readLibrary();
              json(response, 200, {
                recommendations: recommendStickers(library.stickers, input.words, input.durationSec),
              });
            } catch (error) {
              json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }

        if (url.pathname === "/__studio/sticker-library/selection") {
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
              const input = selectionRequest(await readJson(request));
              const library = await readLibrary();
              const stickers = input.ids.map((id) => {
                const entry = library.stickers.find((candidate) => candidate.id === id);
                if (entry === undefined) throw new Error(`Sticker ${id} does not exist.`);
                const selectedPlacement = input.placements.get(id);
                const suggestedText = entry.textMode === "blank" ? input.suggestedTexts.get(id) : undefined;
                return {
                  id: entry.id,
                  name: entry.name,
                  file: entry.file,
                  mediaType: entry.mediaType,
                  textMode: entry.textMode,
                  tags: entry.tags,
                  ...(suggestedText === undefined ? {} : { suggestedText }),
                  ...(selectedPlacement === undefined ? {} : { placement: selectedPlacement }),
                } satisfies StickerSelectionEntry;
              });
              const document: StickerSelectionDocument = {
                format: "hypit.sticker-selection@1",
                updatedAt: new Date().toISOString(),
                stickers,
              };
              await writeAtomic(selectionPath, document);
              json(response, 200, document);
            } catch (error) {
              json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }
          })();
          return;
        }

        if (url.pathname === "/__studio/sticker-library/asset") {
          const id = url.searchParams.get("id");
          if (id === null) {
            json(response, 400, { error: "Choose a sticker id." });
            return;
          }
          void assetPath(id).then(async (path) => {
            if (path === undefined) {
              response.statusCode = 404;
              response.end();
              return;
            }
            const metadata = await stat(path);
            const bytes = await readFile(path);
            let selectedRange: { readonly start: number; readonly end: number } | undefined;
            try {
              selectedRange = byteRange(request.headers.range, metadata.size);
            } catch (error) {
              if (!(error instanceof RangeError)) throw error;
              response.statusCode = 416;
              response.setHeader("content-range", `bytes */${metadata.size}`);
              response.end();
              return;
            }
            const entry = (await readLibrary()).stickers.find((candidate) => candidate.id === id)!;
            response.statusCode = selectedRange === undefined ? 200 : 206;
            response.setHeader("content-type", entry.mediaType);
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

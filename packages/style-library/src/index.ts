import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export type StyleLibraryStatus = "analyzed" | "draft" | "retired" | "verified";

export type StyleLibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly latestVersion: string;
  readonly status: StyleLibraryStatus;
  readonly tags: readonly string[];
  readonly sourceSha256: string;
  readonly preview: string;
  readonly versionCount: number;
};

export type StyleSourceMetadata = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

export type StyleVersionMetadata = {
  readonly format: "hypit.style-version@1";
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly summary: string;
  readonly status: StyleLibraryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: StyleSourceMetadata;
  readonly reference: {
    readonly audio: string;
    readonly transcript: string;
    readonly asrEngine: string;
  };
  readonly analysis: {
    readonly summary: string;
    readonly timeline: string;
    readonly style: string;
    readonly evidence: readonly string[];
  };
  readonly preview: string;
  readonly tags: readonly string[];
};

export type StyleLibraryDetail = {
  readonly entry: StyleLibraryEntry;
  readonly metadata: StyleVersionMetadata;
  readonly style: unknown;
  readonly documents: {
    readonly analysis: string;
    readonly timeline: string;
  };
};

export type StyleAsset = {
  readonly path: string;
  readonly mediaType: string;
};

export type StyleLibrary = {
  readonly root: string;
  list(): Promise<readonly StyleLibraryEntry[]>;
  detail(id: string, version?: string): Promise<StyleLibraryDetail>;
  asset(id: string, version: string, name: string): Promise<StyleAsset | undefined>;
};

type RawIndex = {
  readonly format?: unknown;
  readonly styles?: unknown;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, subject: string): string {
  assert(typeof value === "string" && value.trim().length > 0, `${subject} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, subject: string): readonly string[] {
  assert(Array.isArray(value), `${subject} must be an array`);
  return value.map((item, index) => string(item, `${subject}[${index}]`));
}

function fingerprint(value: unknown, subject: string): string {
  const result = string(value, subject);
  assert(/^[a-f0-9]{64}$/iu.test(result), `${subject} must be a SHA-256 fingerprint`);
  return result.toUpperCase();
}

function positiveNumber(value: unknown, subject: string): number {
  assert(typeof value === "number" && Number.isFinite(value) && value > 0, `${subject} must be positive`);
  return value;
}

function status(value: unknown, subject: string): StyleLibraryStatus {
  assert(value === "draft" || value === "analyzed" || value === "verified" || value === "retired",
    `${subject} has an invalid status`);
  return value;
}

function identifier(value: unknown, subject: string): string {
  const result = string(value, subject);
  assert(/^[a-z0-9][a-z0-9-]*$/u.test(result), `${subject} must be a lowercase identifier`);
  return result;
}

function version(value: unknown, subject: string): string {
  const result = string(value, subject);
  assert(/^\d{4,}$/u.test(result), `${subject} must be a numeric version`);
  return result;
}

function relativePath(value: unknown, subject: string): string {
  const result = string(value, subject);
  assert(!isAbsolute(result), `${subject} must be relative`);
  const normalized = result.replaceAll("\\", "/");
  assert(!normalized.split("/").includes(".."), `${subject} cannot escape the style version`);
  return normalized;
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".json": return "application/json; charset=utf-8";
    case ".md": return "text/markdown; charset=utf-8";
    case ".mp4": return "video/mp4";
    case ".png": return "image/png";
    case ".wav": return "audio/wav";
    default: return "application/octet-stream";
  }
}

function parseIndex(value: unknown): readonly StyleLibraryEntry[] {
  const raw = object(value, "Style library index") as RawIndex;
  assert(raw.format === "hypit.style-library@1", "Style library index has an unsupported format");
  assert(Array.isArray(raw.styles), "Style library index styles must be an array");
  return raw.styles.map((item, index) => {
    const entry = object(item, `styles[${index}]`);
    const result = {
      id: identifier(entry.id, `styles[${index}].id`),
      name: string(entry.name, `styles[${index}].name`),
      summary: string(entry.summary, `styles[${index}].summary`),
      latestVersion: version(entry.latestVersion, `styles[${index}].latestVersion`),
      status: status(entry.status, `styles[${index}].status`),
      tags: stringArray(entry.tags, `styles[${index}].tags`),
      sourceSha256: fingerprint(entry.sourceSha256, `styles[${index}].sourceSha256`),
      preview: relativePath(entry.preview, `styles[${index}].preview`),
      versionCount: positiveNumber(entry.versionCount, `styles[${index}].versionCount`),
    } satisfies StyleLibraryEntry;
    assert(Number.isSafeInteger(result.versionCount), `styles[${index}].versionCount must be an integer`);
    return result;
  });
}

function parseMetadata(value: unknown, expectedId: string, expectedVersion: string): StyleVersionMetadata {
  const raw = object(value, "Style version metadata");
  assert(raw.format === "hypit.style-version@1", "Style version metadata has an unsupported format");
  assert(identifier(raw.id, "Style version id") === expectedId, "Style version id does not match the index");
  assert(version(raw.version, "Style version") === expectedVersion, "Style version does not match the index");
  const source = object(raw.source, "Style source");
  const reference = object(raw.reference, "Style reference");
  const analysis = object(raw.analysis, "Style analysis");
  const bytes = positiveNumber(source.bytes, "Style source bytes");
  const durationSec = positiveNumber(source.durationSec, "Style source durationSec");
  const width = positiveNumber(source.width, "Style source width");
  const height = positiveNumber(source.height, "Style source height");
  const fps = positiveNumber(source.fps, "Style source fps");
  assert([bytes, width, height].every(Number.isSafeInteger), "Style source pixel and byte counts must be integers");
  return {
    format: "hypit.style-version@1",
    id: expectedId,
    version: expectedVersion,
    name: string(raw.name, "Style version name"),
    summary: string(raw.summary, "Style version summary"),
    status: status(raw.status, "Style version status"),
    createdAt: string(raw.createdAt, "Style version createdAt"),
    updatedAt: string(raw.updatedAt, "Style version updatedAt"),
    source: {
      path: relativePath(source.path, "Style source path"),
      sha256: fingerprint(source.sha256, "Style source sha256"),
      bytes,
      durationSec,
      width,
      height,
      fps,
    },
    reference: {
      audio: relativePath(reference.audio, "Style reference audio"),
      transcript: relativePath(reference.transcript, "Style reference transcript"),
      asrEngine: string(reference.asrEngine, "Style reference asrEngine"),
    },
    analysis: {
      summary: relativePath(analysis.summary, "Style analysis summary"),
      timeline: relativePath(analysis.timeline, "Style analysis timeline"),
      style: relativePath(analysis.style, "Style analysis style"),
      evidence: stringArray(analysis.evidence, "Style analysis evidence").map((item, index) =>
        relativePath(item, `Style analysis evidence[${index}]`)),
    },
    preview: relativePath(raw.preview, "Style preview"),
    tags: stringArray(raw.tags, "Style tags"),
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read style library file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function inside(root: string, path: string): string {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  assert(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    `Style asset escapes its version: ${path}`);
  return absolute;
}

export function createStyleLibrary(root: string): StyleLibrary {
  const libraryRoot = resolve(root);
  const loadIndex = async (): Promise<readonly StyleLibraryEntry[]> =>
    parseIndex(await readJson(resolve(libraryRoot, "index.json")));
  const entryFor = async (id: string): Promise<StyleLibraryEntry> => {
    const entries = await loadIndex();
    const entry = entries.find((candidate) => candidate.id === id);
    assert(entry !== undefined, `Style ${id} does not exist`);
    return entry;
  };
  const versionRoot = (id: string, selectedVersion: string): string =>
    inside(libraryRoot, `${id}/${selectedVersion}`);
  const metadataFor = async (id: string, selectedVersion: string): Promise<StyleVersionMetadata> => {
    const entry = await entryFor(id);
    const metadata = parseMetadata(
      await readJson(inside(versionRoot(id, selectedVersion), "metadata.json")),
      entry.id,
      selectedVersion,
    );
    assert(metadata.source.sha256 === entry.sourceSha256, "Style source sha256 does not match the library index");
    return metadata;
  };
  const assetPath = (metadata: StyleVersionMetadata, name: string): string | undefined => {
    if (name === "preview") return metadata.preview;
    if (name === "source") return metadata.source.path;
    if (name === "audio") return metadata.reference.audio;
    if (name === "transcript") return metadata.reference.transcript;
    if (name === "analysis") return metadata.analysis.summary;
    if (name === "timeline") return metadata.analysis.timeline;
    if (name === "style") return metadata.analysis.style;
    if (name === "corrections") return "corrections.json";
    const evidence = /^evidence:(\d+)$/u.exec(name);
    if (evidence === null) return undefined;
    return metadata.analysis.evidence[Number(evidence[1])];
  };
  return {
    root: libraryRoot,
    list: loadIndex,
    async detail(id, requestedVersion) {
      const entry = await entryFor(id);
      const selectedVersion = requestedVersion === undefined
        ? entry.latestVersion
        : version(requestedVersion, "Style detail version");
      const metadata = await metadataFor(id, selectedVersion);
      const rootPath = versionRoot(id, selectedVersion);
      const [style, analysis, timeline] = await Promise.all([
        readJson(inside(rootPath, metadata.analysis.style)),
        readFile(inside(rootPath, metadata.analysis.summary), "utf8"),
        readFile(inside(rootPath, metadata.analysis.timeline), "utf8"),
      ]);
      return { entry, metadata, style, documents: { analysis, timeline } };
    },
    async asset(id, requestedVersion, name) {
      const metadata = await metadataFor(id, version(requestedVersion, "Style asset version"));
      const path = assetPath(metadata, name);
      if (path === undefined) return undefined;
      return {
        path: inside(versionRoot(id, metadata.version), path),
        mediaType: mediaType(path),
      };
    },
  };
}

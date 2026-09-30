export const stickerLibraryFormat = "hypit.sticker-library@1" as const;

export type StickerKind = "static" | "animated";
export type StickerTextMode = "blank" | "fixed" | "none";

export type StickerLibraryEntry = {
  readonly id: string;
  readonly name: string;
  readonly kind: StickerKind;
  readonly file: string;
  readonly mediaType: string;
  readonly textMode: StickerTextMode;
  readonly tags: readonly string[];
  readonly createdAt: string;
  readonly size?: number;
};

export type StickerLibraryDocument = {
  readonly format: typeof stickerLibraryFormat;
  readonly updatedAt: string | null;
  readonly stickers: readonly StickerLibraryEntry[];
};

export type StickerTimedWord = {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
};

export type StickerPlacement = {
  readonly startSec: number;
  readonly endSec: number;
  readonly xPercent: number;
  readonly yPercent: number;
  readonly scale: number;
  readonly anchor: "top-left" | "top-center" | "top-right" | "center-left" | "center" | "center-right" | "bottom-left" | "bottom-center" | "bottom-right";
};

export type StickerRecommendation = {
  readonly id: string;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly suggestedText?: string;
  readonly placement: StickerPlacement;
};

const allowedMediaTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "video/webm",
]);

const synonymGroups: readonly { readonly triggers: readonly string[]; readonly terms: readonly string[] }[] = [
  { triggers: ["果香", "水果", "清新"], terms: ["柑橘", "柠檬", "橙子", "葡萄柚", "柚子", "桃子", "梨", "莓果", "浆果", "清甜", "清爽"] },
  { triggers: ["开场", "开头", "标题"], terms: ["首先", "第一", "开始", "开头", "今天", "这次", "先看", "先讲"] },
  { triggers: ["香调", "香材", "强调"], terms: ["前调", "中调", "后调", "木质", "乌木", "沉香", "豆蔻", "花香", "玫瑰", "茉莉", "檀香", "麝香"] },
  { triggers: ["产品", "卖点"], terms: ["香水", "瓶身", "味道", "闻起来", "设计", "容量", "留香", "使用"] },
  { triggers: ["结尾", "行动"], terms: ["最后", "总结", "推荐", "试试", "选择", "入手", "记住"] },
];

const anchorTags: readonly { readonly terms: readonly string[]; readonly anchor: StickerPlacement["anchor"]; readonly xPercent: number; readonly yPercent: number }[] = [
  { terms: ["开场", "标题", "气泡", "顶部"], anchor: "top-center", xPercent: 50, yPercent: 20 },
  { terms: ["香调", "香材", "强调", "卖点"], anchor: "center-right", xPercent: 72, yPercent: 42 },
  { terms: ["箭头", "指示"], anchor: "center-right", xPercent: 78, yPercent: 54 },
  { terms: ["结尾", "行动"], anchor: "bottom-center", xPercent: 50, yPercent: 78 },
  { terms: ["角标", "角落"], anchor: "top-left", xPercent: 22, yPercent: 18 },
];

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sticker library data must be an object.");
  }
  return value as Record<string, unknown>;
}

function safeStickerFile(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0
    || value.startsWith("/") || value.startsWith("\\") || value.includes("..")) {
    throw new Error("Sticker file path is invalid.");
  }
  return value.replaceAll("\\", "/");
}

export function normalizeStickerTags(value: unknown): readonly string[] {
  const items = typeof value === "string" ? value.split(/[,，\n]+/u) : Array.isArray(value) ? value : [];
  const tags = items
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0 && item.length <= 24);
  return [...new Set(tags)].slice(0, 16);
}

export function normalizeStickerTextMode(value: unknown): StickerTextMode {
  return value === "fixed" || value === "none" ? value : "blank";
}

export function parseStickerLibrary(value: unknown): StickerLibraryDocument {
  const raw = record(value);
  if (raw.format !== stickerLibraryFormat || !Array.isArray(raw.stickers)) {
    throw new Error("Sticker library has an unsupported format.");
  }
  if (raw.updatedAt !== null && typeof raw.updatedAt !== "string") {
    throw new Error("Sticker library updatedAt is invalid.");
  }
  const stickers = raw.stickers.map((item, index) => {
    const entry = record(item);
    if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(entry.id)
      || typeof entry.name !== "string" || entry.name.trim().length === 0
      || entry.kind !== "static" && entry.kind !== "animated"
      || typeof entry.mediaType !== "string" || !allowedMediaTypes.has(entry.mediaType)
      || typeof entry.createdAt !== "string") {
      throw new Error(`Sticker entry ${index} is invalid.`);
    }
    return {
      id: entry.id,
      name: entry.name.trim(),
      kind: entry.kind,
      file: safeStickerFile(entry.file),
      mediaType: entry.mediaType,
      textMode: normalizeStickerTextMode(entry.textMode),
      tags: normalizeStickerTags(entry.tags),
      createdAt: entry.createdAt,
      ...(typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0
        ? { size: entry.size } : {}),
    } satisfies StickerLibraryEntry;
  });
  return { format: stickerLibraryFormat, updatedAt: raw.updatedAt, stickers };
}

function scriptText(words: readonly StickerTimedWord[]): string {
  return words.map((word) => word.text).join("").replace(/\s+/gu, "");
}

function matchingTerms(entry: StickerLibraryEntry): readonly string[] {
  const own = [entry.name, ...entry.tags].map((item) => item.trim()).filter((item) => item.length > 1);
  const all = new Set(own);
  const descriptor = own.join(" ");
  for (const group of synonymGroups) {
    if (group.triggers.some((term) => descriptor.includes(term))) {
      for (const term of group.terms) all.add(term);
    }
  }
  return [...all].sort((left, right) => right.length - left.length);
}

function matchedWindow(words: readonly StickerTimedWord[], terms: readonly string[]): { readonly start: number; readonly end: number; readonly terms: readonly string[] } | undefined {
  for (let index = 0; index < words.length; index++) {
    let text = "";
    for (let lookahead = 0; lookahead < 4 && index + lookahead < words.length; lookahead++) {
      text += words[index + lookahead]!.text.replace(/\s+/gu, "");
      const matched = terms.filter((term) => text.includes(term));
      if (matched.length > 0) {
        return {
          start: words[index]!.startSec,
          end: words[index + lookahead]!.endSec,
          terms: matched,
        };
      }
    }
  }
  return undefined;
}

function placementFor(
  entry: StickerLibraryEntry,
  hit: ReturnType<typeof matchedWindow>,
  durationSec: number,
): StickerPlacement {
  const descriptors = [entry.name, ...entry.tags].join(" ");
  const anchor = anchorTags.find((candidate) => candidate.terms.some((term) => descriptors.includes(term)))
    ?? { anchor: "center" as const, xPercent: 50, yPercent: 45 };
  const longest = Math.max(2, ...[entry.name, ...entry.tags].map((term) => term.length));
  const length = Math.max(2.2, Math.min(4.8, 1.5 + longest * 0.35));
  const fallback = descriptors.includes("开场") || descriptors.includes("标题") ? 0
    : descriptors.includes("结尾") || descriptors.includes("行动") ? Math.max(0, durationSec - length)
      : Math.max(0, durationSec / 2 - length / 2);
  const startSec = Math.max(0, Math.min(Math.max(0, durationSec - 0.8), (hit?.start ?? fallback) - 0.15));
  const endSec = Math.max(startSec + 0.8, Math.min(durationSec, Math.max(hit?.end ?? startSec, startSec + length) + 0.8));
  return {
    startSec: Number(startSec.toFixed(3)),
    endSec: Number(endSec.toFixed(3)),
    xPercent: anchor.xPercent,
    yPercent: anchor.yPercent,
    scale: 1,
    anchor: anchor.anchor,
  };
}

export function recommendStickers(
  entries: readonly StickerLibraryEntry[],
  words: readonly StickerTimedWord[],
  durationSec: number,
): readonly StickerRecommendation[] {
  const transcript = scriptText(words);
  const safeDuration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  return entries.map((entry) => {
    const ownTerms = [entry.name, ...entry.tags].map((item) => item.trim()).filter((item) => item.length > 1);
    const terms = matchingTerms(entry);
    const matchedTerms = new Set<string>();
    let score = 0;
    if (transcript.includes(entry.name)) score += 16;
    for (const tag of entry.tags) {
      if (transcript.includes(tag)) {
        score += 10;
        matchedTerms.add(tag);
      }
    }
    for (const group of synonymGroups) {
      if (!group.triggers.some((term) => ownTerms.some((own) => own.includes(term) || term.includes(own)))) continue;
      const hit = group.terms.find((term) => transcript.includes(term));
      if (hit !== undefined) {
        score += 7;
        matchedTerms.add(hit);
      }
    }
    const hit = matchedWindow(words, terms);
    if (hit !== undefined) {
      score += 4;
      for (const term of hit.terms) matchedTerms.add(term);
    }
    const suggestedText = entry.textMode === "blank"
      ? [...(hit?.terms ?? [])].sort((left, right) => right.length - left.length)[0]
      : undefined;
    return {
      id: entry.id,
      score,
      matchedTerms: [...matchedTerms].slice(0, 6),
      ...(suggestedText === undefined ? {} : { suggestedText }),
      placement: placementFor(entry, hit, safeDuration),
    } satisfies StickerRecommendation;
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

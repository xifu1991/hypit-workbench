import type { StyleLibraryEntry } from "@hypit/style-library";

export type StyleTimedWords = {
  readonly text: string;
  readonly startSec: number;
  readonly endSec: number;
};

export type StylePlanWindow = {
  readonly index: number;
  readonly startSec: number;
  readonly endSec: number;
  readonly styleId: string;
  readonly styleName: string;
  readonly confidence: number;
  readonly reason: string;
  readonly matchedTerms: readonly string[];
  readonly text: string;
};

export type StylePlanDocument = {
  readonly format: "hypit.style-plan@1";
  readonly updatedAt: string | null;
  readonly durationSec: number;
  readonly windowRangeSec: {
    readonly min: number;
    readonly max: number;
  };
  readonly sourceRevision?: number;
  readonly sourcePath?: string;
  readonly windows: readonly StylePlanWindow[];
};

type Concept = {
  readonly id: string;
  readonly triggers: readonly string[];
  readonly markers: readonly string[];
};

type ScoredStyle = {
  readonly entry: StyleLibraryEntry;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly concepts: readonly string[];
};

export type StylePlanOptions = {
  readonly candidateIds?: readonly string[];
  readonly sourceRevision?: number;
  readonly sourcePath?: string;
  readonly updatedAt?: string;
};

const minimumWindowSec = 2;
const maximumWindowSec = 5;
const targetWindowSec = 3.5;

const concepts: readonly Concept[] = [
  {
    id: "presenter",
    triggers: [
      "真人", "口播", "主播", "我认为", "我觉得", "分享", "开场", "第一", "今天", "这次",
      "下午", "晚上", "约会", "我会", "适合", "大家", "收藏",
    ],
    markers: ["真人", "口播", "主播", "信任", "开场", "出镜"],
  },
  {
    id: "product",
    triggers: [
      "香水", "产品", "瓶子", "瓶身", "设计", "限量", "价格", "味道", "香调", "留香",
      "喷", "使用", "入手", "醇厚", "耐闻", "品牌", "阿玛尼", "红挚爱", "黑鸦片", "YSL",
    ],
    markers: ["产品", "产品特写", "产品阵列", "产品花字", "卖点", "品牌", "香水", "瓶身", "跟随"],
  },
  {
    id: "material",
    triggers: [
      "玫瑰", "松露", "花瓣", "浆果", "木质", "茉莉", "橙花", "香草", "原料", "配方",
      "成分", "果香", "花香", "香材", "绿叶", "植物",
    ],
    markers: ["原料", "玫瑰", "松露", "香调", "微距", "配方", "成分", "色彩矩阵", "花材"],
  },
  {
    id: "graphic",
    triggers: [
      "为什么", "到底", "怎么会", "怎么", "如何", "是不是", "问题", "误区", "秘密", "注意",
      "重点", "不要", "别", "约会", "晚餐", "电影", "夜晚", "场景",
    ],
    markers: ["黑底", "图形", "标签", "标题", "网格", "画中画", "场景词", "悬念", "问号"],
  },
  {
    id: "editorial",
    triggers: [
      "历史", "经典", "名人", "品牌故事", "艺术", "复古", "当年", "创始", "传统", "文化",
      "资料", "权威", "画报",
    ],
    markers: ["档案", "权威", "名人", "资料", "艺术", "拼贴", "复古", "画报", "品牌故事", "叙事"],
  },
  {
    id: "finale",
    triggers: ["最后", "总结", "推荐", "收藏", "记住", "入手", "选择", "值得", "收官", "高级感"],
    markers: ["黑金", "高级感", "产品阵列", "收官", "品牌", "收束"],
  },
  {
    id: "evidence",
    triggers: ["证据", "实验", "效果", "明显", "看见", "对比", "测试", "真实", "证明", "变化"],
    markers: ["证据", "微距", "对比", "矩阵", "高光", "停顿", "戏剧", "蒙太奇"],
  },
];

function round(value: number): number {
  return Number(value.toFixed(3));
}

function normalized(value: string): string {
  return value.replace(/\s+/gu, "").toLocaleLowerCase();
}

function ownTerms(entry: StyleLibraryEntry): readonly string[] {
  return [entry.id, entry.name, ...entry.tags]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function styleDescriptor(entry: StyleLibraryEntry): string {
  return normalized([entry.id, entry.name, entry.summary, ...entry.tags].join(" "));
}

function phaseFor(startSec: number, endSec: number, durationSec: number): "opening" | "middle" | "closing" {
  if (startSec < Math.min(8, durationSec * 0.2)) return "opening";
  if (endSec > durationSec * 0.82) return "closing";
  return "middle";
}

function scoreStyle(
  entry: StyleLibraryEntry,
  text: string,
  phase: ReturnType<typeof phaseFor>,
): ScoredStyle {
  const descriptor = styleDescriptor(entry);
  const matched = new Set<string>();
  const conceptsMatched = new Set<string>();
  let score = 0;

  for (const term of ownTerms(entry)) {
    const normalizedTerm = normalized(term);
    if (normalizedTerm.length >= 2 && text.includes(normalizedTerm)) {
      score += 12;
      matched.add(term);
    }
  }

  for (const concept of concepts) {
    const textHits = concept.triggers.filter((term) => text.includes(normalized(term)));
    if (textHits.length === 0) continue;
    const styleHits = concept.markers.filter((term) => descriptor.includes(normalized(term)));
    if (styleHits.length === 0) continue;
    score += Math.min(2, textHits.length) * Math.min(2, styleHits.length) * 6;
    conceptsMatched.add(concept.id);
    for (const term of textHits.slice(0, 2)) matched.add(term);
  }

  if (phase === "opening" && conceptsMatched.has("presenter")) score += 8;
  if (phase === "closing" && conceptsMatched.has("finale")) score += 9;
  if (phase === "middle" && conceptsMatched.has("evidence")) score += 4;

  return {
    entry,
    score,
    matchedTerms: [...matched].slice(0, 6),
    concepts: [...conceptsMatched],
  };
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function fallbackStyle(
  entries: readonly StyleLibraryEntry[],
  phase: ReturnType<typeof phaseFor>,
  index: number,
): StyleLibraryEntry {
  const preferred = entries.filter((entry) => {
    const descriptor = styleDescriptor(entry);
    if (phase === "opening") return descriptor.includes("口播") || descriptor.includes("真人") || descriptor.includes("开场");
    if (phase === "closing") return descriptor.includes("收官") || descriptor.includes("高级感") || descriptor.includes("产品阵列");
    return descriptor.includes("产品") || descriptor.includes("原料") || descriptor.includes("图形");
  });
  const pool = preferred.length > 0 ? preferred : entries;
  return pool[hash(`${phase}:${index}`) % pool.length]!;
}

function windowText(words: readonly StyleTimedWords[], startSec: number, endSec: number): string {
  const values = words
    .filter((word) => word.endSec > startSec && word.startSec < endSec)
    .map((word) => normalized(word.text))
    .filter((word) => word.length > 0);
  return [...new Set(values)].join(" ").slice(0, 240);
}

function boundaries(words: readonly StyleTimedWords[], durationSec: number): readonly number[] {
  return [...new Set(words
    .flatMap((word) => [word.startSec, word.endSec])
    .filter((value) => Number.isFinite(value) && value > 0 && value < durationSec)
    .map(round))]
    .sort((left, right) => left - right);
}

function windowRanges(durationSec: number, words: readonly StyleTimedWords[]): readonly { readonly startSec: number; readonly endSec: number }[] {
  if (durationSec <= maximumWindowSec) return [{ startSec: 0, endSec: round(durationSec) }];
  const semanticBoundaries = boundaries(words, durationSec);
  const result: { readonly startSec: number; readonly endSec: number }[] = [];
  let startSec = 0;
  while (durationSec - startSec > maximumWindowSec) {
    const lower = startSec + minimumWindowSec;
    const upper = Math.min(durationSec, startSec + maximumWindowSec);
    const target = startSec + targetWindowSec;
    const candidates = [
      target,
      ...semanticBoundaries.filter((value) => value >= lower && value <= upper),
    ];
    const endSec = candidates.reduce((best, candidate) => {
      const semantic = semanticBoundaries.includes(candidate);
      const candidateScore = -Math.abs(candidate - target) + (semantic ? 0.35 : 0);
      const bestSemantic = semanticBoundaries.includes(best);
      const bestScore = -Math.abs(best - target) + (bestSemantic ? 0.35 : 0);
      return candidateScore > bestScore ? candidate : best;
    }, target);
    result.push({ startSec: round(startSec), endSec: round(endSec) });
    startSec = endSec;
  }
  result.push({ startSec: round(startSec), endSec: round(durationSec) });
  return result;
}

export function recommendStylePlan(
  entries: readonly StyleLibraryEntry[],
  words: readonly StyleTimedWords[],
  durationSec: number,
  options: StylePlanOptions = {},
): StylePlanDocument {
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("Style plan duration must be positive.");
  const candidates = options.candidateIds === undefined
    ? entries
    : entries.filter((entry) => options.candidateIds!.includes(entry.id));
  if (candidates.length === 0) throw new Error("No styles are available to plan this edit.");

  const windows: StylePlanWindow[] = [];
  const recentStyles: string[] = [];
  const usage = new Map<string, number>();
  for (const [index, range] of windowRanges(durationSec, words).entries()) {
    const text = windowText(words, range.startSec, range.endSec);
    const phase = phaseFor(range.startSec, range.endSec, durationSec);
    const scored = candidates
      .map((entry) => scoreStyle(entry, text, phase))
      .map((result) => {
        const immediateRepeat = recentStyles.at(-1) === result.entry.id ? 18 : 0;
        const recentRepeat = recentStyles.slice(0, -1).includes(result.entry.id) ? 7 : 0;
        const spreadPenalty = Math.min(8, (usage.get(result.entry.id) ?? 0) * 1.5);
        return {
          ...result,
          adjustedScore: result.score - immediateRepeat - recentRepeat - spreadPenalty,
        };
      })
      .sort((left, right) =>
        right.adjustedScore - left.adjustedScore
        || hash(`${index}:${left.entry.id}`) - hash(`${index}:${right.entry.id}`)
        || left.entry.id.localeCompare(right.entry.id));
    const best = scored[0]!;
    let selected = best.score > 0
      ? best
      : (() => {
          const entry = fallbackStyle(candidates, phase, index);
          return {
            entry,
            score: 0,
            matchedTerms: [] as readonly string[],
            concepts: [] as readonly string[],
          } satisfies ScoredStyle;
        })();
    if (recentStyles.at(-1) === selected.entry.id) {
      selected = scored.find((candidate) => candidate.entry.id !== selected.entry.id) ?? selected;
    }
    const reason = selected.matchedTerms.length > 0
      ? `匹配文案「${selected.matchedTerms.slice(0, 3).join("、")}」`
      : phase === "opening"
        ? "开场建立人物与产品信任"
        : phase === "closing"
          ? "结尾收束品牌与产品价值"
          : "按当前段落位置选择中性叙事镜头";
    windows.push({
      index,
      startSec: range.startSec,
      endSec: range.endSec,
      styleId: selected.entry.id,
      styleName: selected.entry.name,
      confidence: Number(Math.min(0.99, selected.score === 0 ? 0.35 : 0.45 + selected.score / 36).toFixed(2)),
      reason,
      matchedTerms: selected.matchedTerms,
      text,
    } satisfies StylePlanWindow);
    recentStyles.push(selected.entry.id);
    if (recentStyles.length > 3) recentStyles.shift();
    usage.set(selected.entry.id, (usage.get(selected.entry.id) ?? 0) + 1);
  }

  return {
    format: "hypit.style-plan@1",
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    durationSec: round(durationSec),
    windowRangeSec: { min: minimumWindowSec, max: maximumWindowSec },
    ...(options.sourceRevision === undefined ? {} : { sourceRevision: options.sourceRevision }),
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    windows,
  };
}

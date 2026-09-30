import assert from "node:assert/strict";
import test from "node:test";

import { recommendStylePlan } from "../src/style-recommender.js";

const entries = [
  {
    id: "presenter-open",
    name: "真人口播开场",
    summary: "真人出镜建立信任。",
    latestVersion: "0001",
    status: "verified",
    tags: ["真人", "口播", "开场"],
    sourceSha256: "A".repeat(64),
    preview: "presenter-open/0001/preview.jpg",
    versionCount: 1,
  },
  {
    id: "product-hero",
    name: "产品特写",
    summary: "产品瓶身与卖点特写。",
    latestVersion: "0001",
    status: "verified",
    tags: ["产品", "产品特写", "卖点"],
    sourceSha256: "B".repeat(64),
    preview: "product-hero/0001/preview.jpg",
    versionCount: 1,
  },
  {
    id: "material-macro",
    name: "原料微距",
    summary: "玫瑰和植物原料证据镜头。",
    latestVersion: "0001",
    status: "verified",
    tags: ["原料", "玫瑰", "微距"],
    sourceSha256: "C".repeat(64),
    preview: "material-macro/0001/preview.jpg",
    versionCount: 1,
  },
  {
    id: "graphic-question",
    name: "问题网格",
    summary: "用问题、误区和悬念组织图形镜头。",
    latestVersion: "0001",
    status: "verified",
    tags: ["图形", "问题", "悬念", "黑底"],
    sourceSha256: "D".repeat(64),
    preview: "graphic-question/0001/preview.jpg",
    versionCount: 1,
  },
  {
    id: "editorial-archive",
    name: "品牌档案",
    summary: "历史、经典与名人资料插片。",
    latestVersion: "0001",
    status: "verified",
    tags: ["档案", "历史", "经典", "名人"],
    sourceSha256: "E".repeat(64),
    preview: "editorial-archive/0001/preview.jpg",
    versionCount: 1,
  },
  {
    id: "premium-finale",
    name: "黑金收官",
    summary: "品牌总结与产品阵列收束。",
    latestVersion: "0001",
    status: "verified",
    tags: ["黑金", "高级感", "产品阵列", "收官"],
    sourceSha256: "F".repeat(64),
    preview: "premium-finale/0001/preview.jpg",
    versionCount: 1,
  },
] as const;

test("style plan covers the edit in 2-5 second semantic windows", () => {
  const plan = recommendStylePlan(entries, [
    { text: "下午临时要约会", startSec: 0, endSec: 3 },
    { text: "阿玛尼红挚爱产品瓶身", startSec: 3, endSec: 7 },
    { text: "玫瑰茉莉草木质原料", startSec: 7, endSec: 11 },
    { text: "到底为什么是不是误区", startSec: 11, endSec: 15 },
    { text: "品牌历史和经典名人", startSec: 15, endSec: 19 },
    { text: "最后总结值得入手", startSec: 19, endSec: 22 },
  ], 22, { sourcePath: "edit.svml", sourceRevision: 4 });

  assert.equal(plan.format, "hypit.style-plan@1");
  assert.equal(plan.windows[0]?.startSec, 0);
  assert.equal(plan.windows.at(-1)?.endSec, 22);
  for (const [index, window] of plan.windows.entries()) {
    assert.ok(window.endSec - window.startSec >= 2);
    assert.ok(window.endSec - window.startSec <= 5);
    if (index > 0) assert.equal(window.startSec, plan.windows[index - 1]?.endSec);
    if (index > 0) assert.notEqual(window.styleId, plan.windows[index - 1]?.styleId);
  }
  assert.ok(new Set(plan.windows.map((window) => window.styleId)).size >= 4);
});

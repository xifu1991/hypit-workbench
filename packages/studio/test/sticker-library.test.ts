import assert from "node:assert/strict";
import test from "node:test";

import { normalizeStickerTags, parseStickerLibrary, recommendStickers } from "../src/sticker-library.js";

test("sticker tags are normalized without duplicates", () => {
  assert.deepEqual(normalizeStickerTags("香水, 果香，开场\n果香"), ["香水", "果香", "开场"]);
});

test("sticker library rejects paths that escape the library root", () => {
  assert.throws(() => parseStickerLibrary({
    format: "hypit.sticker-library@1",
    updatedAt: null,
    stickers: [{
      id: "bad",
      name: "Bad",
      kind: "static",
      file: "../outside.png",
      mediaType: "image/png",
      tags: [],
      createdAt: "2026-09-26T00:00:00.000Z",
    }],
  }), /file path/u);
});

test("sticker recommendations match transcript meaning and semantic time", () => {
  const library = parseStickerLibrary({
    format: "hypit.sticker-library@1",
    updatedAt: null,
    stickers: [{
      id: "fruity-opening",
      name: "果香开场",
      kind: "static",
      file: "stickers/fruity-opening.png",
      mediaType: "image/png",
      tags: ["香水", "果香", "开场", "清新"],
      createdAt: "2026-09-26T00:00:00.000Z",
    }],
  });
  const [recommendation] = recommendStickers(library.stickers, [
    { text: "这支", startSec: 0, endSec: 0.3 },
    { text: "香水", startSec: 0.3, endSec: 0.8 },
    { text: "果香", startSec: 0.8, endSec: 1.2 },
    { text: "开场", startSec: 1.2, endSec: 1.6 },
  ], 30);
  assert.equal(recommendation?.id, "fruity-opening");
  assert.equal(recommendation?.placement.anchor, "top-center");
  assert.ok((recommendation?.placement.startSec ?? 1) <= 1);
  assert.ok((recommendation?.placement.endSec ?? 0) > (recommendation?.placement.startSec ?? 0));
  assert.ok((recommendation?.score ?? 0) >= 30);
});

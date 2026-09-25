import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStyleLibrary } from "../src/index.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hypit-style-library-"));
  const versionRoot = join(root, "sample-style", "0001");
  await mkdir(join(versionRoot, "analysis"), { recursive: true });
  await mkdir(join(versionRoot, "reference"), { recursive: true });
  await mkdir(join(versionRoot, "preview"), { recursive: true });
  await writeFile(join(root, "index.json"), JSON.stringify({
    format: "hypit.style-library@1",
    styles: [{
      id: "sample-style",
      name: "Sample style",
      summary: "A compact test style.",
      latestVersion: "0001",
      status: "analyzed",
      tags: ["talking-head", "product"],
      sourceSha256: "a".repeat(64),
      preview: "sample-style/0001/preview/cover.jpg",
      versionCount: 1,
    }],
  }));
  await writeFile(join(versionRoot, "metadata.json"), JSON.stringify({
    format: "hypit.style-version@1",
    id: "sample-style",
    version: "0001",
    name: "Sample style",
    summary: "A compact test style.",
    status: "analyzed",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    source: {
      path: "reference/source.mp4",
      sha256: "a".repeat(64),
      bytes: 5,
      durationSec: 1,
      width: 1080,
      height: 1920,
      fps: 30,
    },
    reference: {
      audio: "reference/audio.wav",
      transcript: "reference/transcript.json",
      asrEngine: "volc-seedasr-2.0",
    },
    analysis: {
      summary: "analysis/ANALYSIS.md",
      timeline: "analysis/TIMELINE.md",
      style: "analysis/style.json",
      evidence: ["analysis/evidence-a.jpg", "analysis/evidence-b.jpg"],
    },
    preview: "preview/cover.jpg",
    tags: ["talking-head", "product"],
  }));
  await writeFile(join(versionRoot, "analysis", "ANALYSIS.md"), "# Analysis\n\nKeep the spoken voice as the trust anchor.\n");
  await writeFile(join(versionRoot, "analysis", "TIMELINE.md"), "# Timeline\n\n00:00 full-frame presenter\n");
  await writeFile(join(versionRoot, "analysis", "style.json"), JSON.stringify({ pacing: "fast" }));
  await writeFile(join(versionRoot, "analysis", "evidence-a.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(versionRoot, "analysis", "evidence-b.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(versionRoot, "reference", "source.mp4"), Buffer.from("video"));
  await writeFile(join(versionRoot, "reference", "audio.wav"), Buffer.from("audio"));
  await writeFile(join(versionRoot, "reference", "transcript.json"), JSON.stringify({ words: [] }));
  await writeFile(join(versionRoot, "preview", "cover.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(versionRoot, "corrections.json"), JSON.stringify({ version: 1, notes: [] }));
  return root;
}

test("style library resolves indexed versions, documents and typed assets", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = createStyleLibrary(root);

  assert.equal((await library.list())[0]?.id, "sample-style");
  assert.equal((await library.list())[0]?.sourceSha256, "A".repeat(64));
  const detail = await library.detail("sample-style");
  assert.equal(detail.metadata.status, "analyzed");
  assert.equal(detail.documents.analysis, "# Analysis\n\nKeep the spoken voice as the trust anchor.\n");
  assert.deepEqual(detail.style, { pacing: "fast" });
  assert.equal((await library.asset("sample-style", "0001", "preview"))?.mediaType, "image/jpeg");
  assert.equal((await library.asset("sample-style", "0001", "source"))?.mediaType, "video/mp4");
  assert.equal((await library.asset("sample-style", "0001", "transcript"))?.mediaType, "application/json; charset=utf-8");
});

test("style library rejects unknown assets and version traversal", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const library = createStyleLibrary(root);

  assert.equal(await library.asset("sample-style", "0001", "evidence:99"), undefined);
  await assert.rejects(() => library.asset("sample-style", "../0002", "preview"), /numeric version/u);
  await assert.rejects(() => library.detail("../../outside"), /does not exist/u);
});

test("style library rejects a stale source fingerprint", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadataPath = join(root, "sample-style", "0001", "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    source: { sha256: string };
  };
  metadata.source.sha256 = "b".repeat(64);
  await writeFile(metadataPath, JSON.stringify(metadata));

  await assert.rejects(() => createStyleLibrary(root).detail("sample-style"), /does not match/u);
});

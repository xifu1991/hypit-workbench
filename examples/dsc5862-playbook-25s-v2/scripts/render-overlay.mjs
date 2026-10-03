import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(
  "C:/Users/admin/Documents/视频制作/hypit-local-demo/package.json"
);
const puppeteer = require("puppeteer-core");

const here = path.dirname(fileURLToPath(import.meta.url));
const overlayDir = path.resolve(here, "../overlay");
const htmlPath = path.join(overlayDir, "index.html");
const framesDir = path.resolve(here, "../qa/frames");
const outWebm = path.resolve(here, "../qa/overlay-alpha-v2.webm");
const chromePath = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ffmpegPath =
  "C:/Users/admin/Documents/视频制作/tools/ffmpeg/ffmpeg.exe";

const fps = 30;
const duration = 24.37;
const totalFrames = Math.round(duration * fps);

fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--hide-scrollbars",
    "--allow-file-access-from-files"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    const img = document.querySelector("#selection-card img");
    if (img && !img.complete) {
      await new Promise((resolve, reject) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", reject, { once: true });
      });
    }
  });

  const ready = await page.evaluate(
    () => !!window.__timelines?.["dsc5862-overlay-25s"]
  );
  if (!ready) throw new Error("overlay timeline not registered");

  for (let i = 0; i < totalFrames; i += 1) {
    const time = i / fps;
    await page.evaluate((t) => {
      window.__timelines["dsc5862-overlay-25s"].seek(t, false);
    }, time);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );
    const name = String(i).padStart(5, "0");
    await page.screenshot({
      path: path.join(framesDir, `frame_${name}.png`),
      omitBackground: true,
      type: "png"
    });
    if (i % 30 === 0) {
      console.log(`frame ${i}/${totalFrames}`);
    }
  }
} finally {
  await browser.close();
}

const encode = spawnSync(
  ffmpegPath,
  [
    "-y",
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, "frame_%05d.png"),
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    "yuva420p",
    "-b:v",
    "0",
    "-crf",
    "30",
    "-auto-alt-ref",
    "0",
    "-an",
    outWebm
  ],
  { encoding: "utf8" }
);

if (encode.status !== 0) {
  console.error(encode.stderr);
  throw new Error("ffmpeg alpha webm encode failed");
}

console.log("written " + outWebm);

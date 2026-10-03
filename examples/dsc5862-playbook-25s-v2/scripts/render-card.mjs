import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(
  "C:/Users/admin/Documents/视频制作/hypit-local-demo/package.json"
);
const puppeteer = require("puppeteer-core");

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(here, "../generated/selection-card.html");
const outPath = path.resolve(here, "../generated/selection-card.png");
const chromePath =
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--hide-scrollbars"
  ]
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 620, height: 470, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle0" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outPath, omitBackground: true, type: "png" });
  console.log("written " + outPath);
} finally {
  await browser.close();
}

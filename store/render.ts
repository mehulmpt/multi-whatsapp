/**
 * Renders the Chrome Web Store graphics from store/src/*.html.
 *   bun run store/render.ts   → store/assets/
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { renderIcon } from "../scripts/icons";
import { findChrome, root } from "../tests/e2e/harness";

const src = join(root, "store/src");
const out = join(root, "store/assets");
await mkdir(out, { recursive: true });

const JOBS: [file: string, w: number, h: number][] = [
  ["1-switch", 1280, 800],
  ["2-popup", 1280, 800],
  ["3-fast", 1280, 800],
  ["4-organise", 1280, 800],
  ["5-private", 1280, 800],
  ["promo-small", 440, 280],
  ["marquee", 1400, 560],
];

// Store icon: 96×96 artwork centred in 128×128 with transparent padding.
await writeFile(join(root, "store/art/icon-96.png"), renderIcon(96));
await writeFile(
  join(src, "icon.html"),
  `<!doctype html><html><body style="margin:0;background:transparent"><img src="../art/icon-96.png" style="display:block;margin:16px;width:96px;height:96px"></body></html>`,
);

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, pipe: true, args: ["--allow-file-access-from-files"] });
try {
  const page = await browser.newPage();
  for (const [file, width, height] of JOBS) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(`file://${join(src, `${file}.html`)}`, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(out, `${file}.jpg`), type: "jpeg", quality: 92 });
  }
  await page.setViewport({ width: 128, height: 128, deviceScaleFactor: 1 });
  await page.goto(`file://${join(src, "icon.html")}`, { waitUntil: "networkidle0" });
  await page.screenshot({ path: join(out, "store-icon-128.png"), omitBackground: true });
} finally {
  await browser.close();
}
console.log("rendered →", out);

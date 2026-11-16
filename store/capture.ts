/**
 * Captures the extension's real UI (popup, in-page switcher, switch page,
 * settings) with fictional demo accounts, for the store graphics.
 *
 *   bun run store/capture.ts   → store/captures/*.png (2× resolution)
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { WA, root, startEnv } from "../tests/e2e/harness";

const out = join(root, "store/captures");
await mkdir(out, { recursive: true });
const env = await startEnv(join(root, "dist"));
const { browser, bgState, ext, waReady, login, openExtPage, viaSwitch } = env;

// Fictional numbers (US 555-01xx and UK Ofcom drama ranges).
const ACCOUNTS = [
  { name: "Personal", phone: "14155550142" },
  { name: "Work", phone: "442079460958" },
  { name: "Side Project", phone: "12125550187" },
];

const light = async (p: Page, w = 1280, h = 800) => {
  await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
};

try {
  let page = await browser.newPage();
  await light(page);
  await page.goto(WA);
  await waReady(page);
  await login(page, ACCOUNTS[0]!.phone, 20);
  await page.evaluate(() => (window as unknown as { __fakeWa: { bulk(t: string): Promise<number> } }).__fakeWa.bulk("A"));
  for (const acc of ACCOUNTS.slice(1)) {
    const popup = await openExtPage("popup.html");
    page = await viaSwitch(() => popup.click("#add"));
    await light(page);
    await login(page, acc.phone, 20);
  }
  // Name the accounts and wait for phone detection.
  const s = await bgState();
  await ext(async () => undefined);
  for (let i = 0; i < 80; i++) {
    const st = await bgState();
    if (st.accounts.every((a) => a.phone)) break;
    // phone is detected for the active account only; switch around to collect all
    await Bun.sleep(100);
  }
  const names = Object.fromEntries(s.accounts.map((a, i) => [a.id, ACCOUNTS[i]!.name]));
  const phones = Object.fromEntries(s.accounts.map((a, i) => [a.id, ACCOUNTS[i]!.phone]));
  const ago = [Date.now() - 2 * 60_000, 0, Date.now() - 3 * 3_600_000];
  await env.ext(() => Promise.resolve());
  const probe = await openExtPage("manifest.json");
  await probe.evaluate(
    async (names, phones, ago) => {
      const { accounts } = (await chrome.storage.local.get("accounts")) as { accounts: { id: string }[] };
      await chrome.storage.local.set({
        accounts: accounts.map((a, i) => ({ ...a, name: names[a.id], phone: phones[a.id], lastUsedAt: ago[i] || undefined })),
      });
    },
    names,
    phones,
    ago,
  );
  const first = s.accounts[0]!.id;

  // Switch to "Personal" (slow-ish: it has ~82k records) and capture the switch page mid-flight.
  const popup = await openExtPage("popup.html");
  await popup.waitForSelector(`.row[data-id="${first}"]`);
  const wa = page;
  await popup.click(`.row[data-id="${first}"]`);
  await wa.waitForSelector(".card", { timeout: 10_000 });
  await wa.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await wa.waitForFunction(() => /Restoring .* \d/.test(document.querySelector(".status")?.textContent ?? ""), { timeout: 20_000, polling: 20 });
  await (await wa.$(".card"))!.screenshot({ path: join(out, "switching.png"), omitBackground: true });
  page = await viaSwitch(async () => undefined);
  await light(page);
  await page.reload();
  await waReady(page);

  // In-page switcher, open.
  await page.hover("multi-whatsapp-dock >>> .tab");
  await page.waitForFunction(() => document.querySelector("multi-whatsapp-dock")!.shadowRoot!.querySelector(".root")!.classList.contains("open"));
  await Bun.sleep(300);
  const box = await page.evaluate(() => {
    const sr = document.querySelector("multi-whatsapp-dock")!.shadowRoot!;
    const a = sr.querySelector(".panel")!.getBoundingClientRect();
    const b = sr.querySelector(".tab")!.getBoundingClientRect();
    const x = Math.min(a.left, b.left) - 24, y = Math.min(a.top, b.top) - 24;
    return { x, y, width: Math.max(a.right, b.right) - x + 0, height: Math.max(a.bottom, b.bottom) - y + 24 };
  });
  await page.evaluate(() => {
    document.body.style.background = "transparent";
    document.querySelector("#app")?.remove();
  });
  await page.screenshot({ path: join(out, "dock.png"), clip: box, omitBackground: true });

  // Popup.
  const pop = await openExtPage("popup.html");
  await light(pop, 340, 600);
  await pop.reload();
  await pop.waitForSelector(".row.active");
  await (await pop.$("body"))!.screenshot({ path: join(out, "popup.png") });

  // Popup with the editor open on "Work".
  await pop.hover(`.row[data-id="${s.accounts[1]!.id}"]`);
  await pop.click(`.row[data-id="${s.accounts[1]!.id}"] [data-act="edit"]`);
  await Bun.sleep(150);
  await pop.mouse.move(0, 0);
  await (await pop.$("body"))!.screenshot({ path: join(out, "popup-edit.png") });

  // Settings page.
  const opts = await openExtPage("options.html");
  await light(opts, 900, 1400);
  await opts.reload();
  await opts.waitForSelector(".row.active");
  await opts.screenshot({ path: join(out, "options.png"), fullPage: true });
  console.log("captured →", out);
} finally {
  await env.close();
}

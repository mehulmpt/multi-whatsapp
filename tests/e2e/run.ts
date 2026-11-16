/**
 * End-to-end test: runs the real, unpacked extension (dist/) in Chrome for
 * Testing against a local fake of https://web.whatsapp.com (DNS-mapped to a
 * local HTTPS server with a strict CSP).
 *
 *   bun run test:e2e            # headless
 *   HEADFUL=1 bun run test:e2e  # watch it
 *   CHROME_PATH=/path/to/chrome bun run test:e2e
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const root = join(import.meta.dir, "../..");
const dist = join(root, "dist");
const fixture = join(import.meta.dir, "fixture");
const shots = join(root, "docs/screenshots");
const WA = "https://web.whatsapp.com/";

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------
const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: performance.now() - t0 });
    console.log(`  ✅ ${name}`);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, error, ms: performance.now() - t0 });
    console.log(`  ❌ ${name}\n     ${error}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function eq<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pw = join(homedir(), "Library/Caches/ms-playwright");
  const candidates: string[] = [];
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      candidates.push(
        join(pw, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(pw, d, "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(pw, d, "chrome-linux/chrome"),
        join(pw, d, "chrome-linux64/chrome"),
      );
    }
  }
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Chrome for Testing not found. Set CHROME_PATH (branded Chrome can't load unpacked extensions from the CLI).");
  return found;
}

async function makeCert(dir: string): Promise<{ key: string; cert: string }> {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const p = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=web.whatsapp.com",
    "-addext", "subjectAltName=DNS:web.whatsapp.com",
  ], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`openssl failed: ${p.stderr.toString()}`);
  return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'", // no 'unsafe-inline': extension UI must not rely on inline styles
  "img-src 'self' data: blob:",
  "worker-src 'self'",
].join("; ");

function startServer(tls: { key: string; cert: string }) {
  const files: Record<string, string> = {
    "/fake-wa.js": "text/javascript",
    "/sw.js": "text/javascript",
    "/fake-wa.css": "text/css",
  };
  return Bun.serve({
    port: 0,
    tls,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/fake-wa.css") {
        return new Response("body{font-family:system-ui;margin:40px;background:#efeae2}", { headers: { "content-type": "text/css" } });
      }
      const type = files[pathname];
      const file = type ? join(fixture, pathname.slice(1)) : join(fixture, "index.html");
      return new Response(Bun.file(file), {
        headers: { "content-type": type ?? "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store" },
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
let browser: Browser;
let extId = "";
const pageErrors: string[] = [];

/**
 * Extension storage is read/written through an extension page rather than the
 * service worker: puppeteer's worker handle goes stale whenever Chrome stops
 * the worker, which MV3 does routinely (and one test does on purpose).
 */
let probe: Page | null = null;
async function ext<T>(fn: () => Promise<T>): Promise<T> {
  if (!probe || probe.isClosed()) {
    probe = await browser.newPage();
    await probe.goto(`chrome-extension://${extId}/manifest.json`);
  }
  return probe.evaluate(fn) as Promise<T>;
}

async function bgState(): Promise<{ accounts: { id: string; name: string; phone?: string }[]; activeId: string | null; pendingOp: unknown }> {
  return ext(async () => {
    const r = await chrome.storage.local.get(["accounts", "activeId", "pendingOp"]);
    return { accounts: (r.accounts ?? []) as never, activeId: (r.activeId ?? null) as string | null, pendingOp: r.pendingOp ?? null };
  });
}

function watchErrors(page: Page, label: string): void {
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`));
}

async function waTab(): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    const pages = await browser.pages();
    const p = pages.find((pg) => pg.url().startsWith(WA));
    if (p) return p;
    await Bun.sleep(100);
  }
  throw new Error("No WhatsApp tab found");
}

/** Wait until the fake WhatsApp app has loaded normally (not the switch page). */
async function waReady(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => location.search === "" && (window as unknown as { __fakeWa?: { ready: boolean } }).__fakeWa?.ready === true,
    { timeout, polling: 100 },
  );
}

type FakeState = {
  loggedIn: boolean; phone?: string; secret?: string; keyExtractable?: boolean; blob?: string;
  chats?: number; byTs?: number; messages?: number; tagged?: number; lastWid?: string; token?: string; versions?: number[];
};
const readWa = (page: Page) => page.evaluate(() => (window as unknown as { __fakeWa: { read(): Promise<FakeState> } }).__fakeWa.read());
const login = (page: Page, phone: string, messages: number) =>
  page.evaluate((p, m) => (window as unknown as { __fakeWa: { login(p: string, m: number): Promise<void> } }).__fakeWa.login(p, m), phone, messages);

async function openExtPage(path: string): Promise<Page> {
  const p = await browser.newPage();
  watchErrors(p, path);
  await p.goto(`chrome-extension://${extId}/${path}`);
  return p;
}

/** Trigger something that navigates the WA tab through a switch, then wait for WhatsApp to be back. */
async function viaSwitch(action: () => Promise<unknown>): Promise<Page> {
  const before = await waTab();
  const nav = before.waitForNavigation({ timeout: 30_000 }).catch(() => undefined);
  await action();
  await nav;
  const page = await waTab();
  await waReady(page);
  return page;
}

function expectAccount(s: FakeState, phone: string, messages: number): void {
  eq(s.loggedIn, true, "logged in");
  eq(s.phone, phone, "phone");
  eq(s.secret, `secret-of-${phone}`, "non-extractable CryptoKey still decrypts the session secret");
  eq(s.keyExtractable, false, "key stays non-extractable");
  eq(s.blob, `avatar-${phone}`, "Blob values survive");
  eq(s.chats, 25, "autoIncrement store count");
  eq(s.byTs, 25, "index entries rebuilt");
  eq(s.messages, messages, "compound-key store count (multi-chunk copy)");
  eq(s.tagged, messages, "multiEntry index rebuilt");
  eq(s.lastWid, JSON.stringify(`${phone}:7@c.us`), "localStorage restored");
  eq(s.token, `token-${phone}`, "localStorage token restored");
  eq(s.versions, [5, 12], "database versions preserved");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const tmp = await mkdtemp(join(tmpdir(), "mwa-e2e-"));
const server = startServer(await makeCert(tmp));
const chrome = findChrome();
console.log(`Chrome: ${chrome}\nFixture: https://web.whatsapp.com → 127.0.0.1:${server.port}\n`);

browser = await puppeteer.launch({
  executablePath: chrome,
  headless: !process.env.HEADFUL,
  pipe: true,
  dumpio: !!process.env.DUMPIO,
  enableExtensions: [dist],
  userDataDir: join(tmp, "profile"),
  defaultViewport: { width: 1280, height: 800 },
  args: [
    `--host-resolver-rules=MAP web.whatsapp.com:443 127.0.0.1:${server.port}`,
    "--ignore-certificate-errors",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});
await mkdir(shots, { recursive: true });
const chromeVersion = await browser.version();
console.log(`${chromeVersion}\n`);

try {
  const ids: Record<string, string> = {};

  await test("Manifest V3 extension loads and its service worker starts", async () => {
    const t = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 10_000 });
    extId = new URL(t.url()).host;
    assert(extId.length === 32, "extension id");
  });

  await test("Fresh install adopts the current session as “Account 1”", async () => {
    let s = await bgState();
    for (let i = 0; i < 50 && s.accounts.length === 0; i++) {
      await Bun.sleep(100);
      s = await bgState();
    }
    eq(s.accounts.length, 1, "one account");
    eq(s.accounts[0]!.name, "Account 1", "name");
    eq(s.activeId, s.accounts[0]!.id, "active");
    ids.a1 = s.accounts[0]!.id;
  });

  let page = await browser.newPage();
  watchErrors(page, "whatsapp");

  await test("In-page switcher renders under a strict CSP (no inline styles allowed)", async () => {
    await page.goto(WA);
    await waReady(page);
    await page.waitForSelector("multi-whatsapp-dock >>> .tab", { timeout: 5000 });
    const bg = await page.$eval("multi-whatsapp-dock >>> .tab", (el) => getComputedStyle(el).backgroundColor);
    assert(bg !== "rgba(0, 0, 0, 0)", `dock stylesheet applied (got ${bg})`);
    const av = await page.$eval("multi-whatsapp-dock >>> .tab .av", (el) => getComputedStyle(el).backgroundColor);
    eq(av, "rgb(37, 211, 102)", "avatar colour applied via CSSOM");
  });

  await test("Logged-in phone number is detected and shown for the account", async () => {
    await login(page, "15550001111", 3000);
    for (let i = 0; i < 70 && !(await bgState()).accounts[0]?.phone; i++) await Bun.sleep(100);
    eq((await bgState()).accounts[0]!.phone, "15550001111", "phone");
  });

  await test("“Add account” from the popup saves account 1 and opens a fresh, logged-out WhatsApp", async () => {
    const popup = await openExtPage("popup.html");
    await popup.waitForSelector(".row");
    await (await popup.$("body"))!.screenshot({ path: join(shots, "popup.png") });
    page = await viaSwitch(() => popup.click("#add"));
    eq((await readWa(page)).loggedIn, false, "fresh session shows QR");
    const s = await bgState();
    eq(s.accounts.length, 2, "two accounts");
    ids.a2 = s.accounts[1]!.id;
    eq(s.activeId, ids.a2, "new account active");
    eq(s.pendingOp, null, "op cleared");
    await login(page, "15550002222", 40);
  });

  await test("Switch via the in-page switcher restores account 1 completely", async () => {
    await page.hover("multi-whatsapp-dock >>> .tab");
    await page.waitForFunction(() => {
      const host = document.querySelector("multi-whatsapp-dock")!;
      return host.shadowRoot!.querySelector(".root")!.classList.contains("open");
    });
    await Bun.sleep(200);
    await page.screenshot({ path: join(shots, "in-page-switcher.png") });
    page = await viaSwitch(() => page.click(`multi-whatsapp-dock >>> .item[data-id="${ids.a1}"]`));
    expectAccount(await readWa(page), "15550001111", 3000);
    eq((await bgState()).activeId, ids.a1, "account 1 active");
  });

  await test("Switch via popup number key restores account 2 completely", async () => {
    const popup = await openExtPage("popup.html");
    await popup.waitForSelector(".row");
    page = await viaSwitch(() => popup.keyboard.press("2"));
    expectAccount(await readWa(page), "15550002222", 40);
  });

  await test("Switch succeeds when WhatsApp's service worker holds the database open", async () => {
    const held = await page.evaluate(() => (window as unknown as { __fakeWa: { holdFromServiceWorker(): Promise<string> } }).__fakeWa.holdFromServiceWorker());
    eq(held, "holding", "service worker holds a connection");
    const popup = await openExtPage("popup.html");
    await popup.waitForSelector(".row");
    page = await viaSwitch(() => popup.click(`.row[data-id="${ids.a1}"]`));
    expectAccount(await readWa(page), "15550001111", 3000);
  });

  await test("Changes made in an account are kept on the next switch", async () => {
    await page.evaluate(() => localStorage.setItem("WAToken", "token-15550001111-rotated"));
    const popup = await openExtPage("popup.html");
    page = await viaSwitch(() => popup.click(`.row[data-id="${ids.a2}"]`));
    eq((await readWa(page)).phone, "15550002222", "on account 2");
    const popup2 = await openExtPage("popup.html");
    page = await viaSwitch(() => popup2.click(`.row[data-id="${ids.a1}"]`));
    eq((await readWa(page)).token, "token-15550001111-rotated", "rotated token persisted");
    await page.evaluate(() => localStorage.setItem("WAToken", "token-15550001111"));
  });

  await test("Duplicate WhatsApp tabs are closed before a switch", async () => {
    const extra = await browser.newPage();
    await extra.goto(WA);
    await waReady(extra);
    const popup = await openExtPage("popup.html");
    page = await viaSwitch(() => popup.click(`.row[data-id="${ids.a2}"]`));
    const tabs = (await browser.pages()).filter((p) => p.url().startsWith(WA));
    eq(tabs.length, 1, "one WhatsApp tab");
    expectAccount(await readWa(page), "15550002222", 40);
  });

  await test("Switching with no WhatsApp tab open opens one", async () => {
    await page.close();
    const popup = await openExtPage("popup.html");
    await popup.click(`.row[data-id="${ids.a1}"]`).catch(() => undefined);
    page = await waTab();
    await waReady(page);
    expectAccount(await readWa(page), "15550001111", 3000);
  });

  await test("State survives a service worker restart", async () => {
    const cdp = await page.createCDPSession();
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await cdp.detach();
    const popup = await openExtPage("popup.html");
    await popup.waitForSelector(".row");
    eq(await popup.$$eval(".row", (r) => r.length), 2, "popup lists both accounts");
    eq(await popup.$eval(".row.active .name", (n) => n.textContent), "Account 1", "active account shown");
    page = await viaSwitch(() => popup.keyboard.press("2"));
    expectAccount(await readWa(page), "15550002222", 40);
  });

  await test("Interrupted switch (session saved, then crash) never overwrites a saved account", async () => {
    // Simulate a crash right after the live session was saved and handed off:
    // activeId is null and the live storage still holds account 2's data.
    await ext(() => chrome.storage.local.set({ activeId: null }));
    await page.evaluate(() => localStorage.setItem("WAToken", "garbage-after-crash"));
    const popup = await openExtPage("popup.html");
    await popup.waitForSelector("#banner:not([hidden])");
    page = await viaSwitch(() => popup.click(`.row[data-id="${ids.a1}"]`));
    expectAccount(await readWa(page), "15550001111", 3000);
    const popup2 = await openExtPage("popup.html");
    page = await viaSwitch(() => popup2.click(`.row[data-id="${ids.a2}"]`));
    expectAccount(await readWa(page), "15550002222", 40);
  });

  await test("Stale switch URLs just load WhatsApp", async () => {
    await page.goto(`${WA}?mwa_op=doesnotexist`);
    await waReady(page);
    expectAccount(await readWa(page), "15550002222", 40);
  });

  await test("Options page: rename + recolour an account", async () => {
    const opts = await openExtPage("options.html");
    await opts.waitForSelector(`.row[data-id="${ids.a1}"]`);
    await opts.waitForSelector(`.row[data-id="${ids.a1}"]`);
    await opts.hover(`.row[data-id="${ids.a1}"]`);
    await opts.click(`.row[data-id="${ids.a1}"] [data-act="edit"]`);
    await opts.waitForSelector(".editor input");
    await opts.$eval(".editor input", (i) => ((i as HTMLInputElement).value = ""));
    await opts.type(".editor input", "Work");
    await opts.click('.swatch[data-color="#3B82F6"]');
    await opts.click('[data-act="save"]');
    for (let i = 0; i < 30 && (await bgState()).accounts[0]!.name !== "Work"; i++) await Bun.sleep(100);
    const a = (await bgState()).accounts.find((x) => x.id === ids.a1) as { name: string; color: string };
    eq([a.name, a.color], ["Work", "#3B82F6"], "updated");
    await opts.waitForSelector(".row");
    await opts.screenshot({ path: join(shots, "options.png"), fullPage: true });
    await opts.close();
  });

  await test("Removing an inactive account deletes its saved session", async () => {
    const opts = await openExtPage("options.html");
    // Add a third account so we can delete one that has a saved vault.
    page = await viaSwitch(() => opts.click("#add"));
    await login(page, "15550003333", 10);
    const s = await bgState();
    ids.a3 = s.activeId!;
    const popup = await openExtPage("popup.html");
    page = await viaSwitch(() => popup.click(`.row[data-id="${ids.a2}"]`));
    const a3dbs = async () => (await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""))).filter((n) => n.startsWith(`mwa:${ids.a3}:`));
    assert((await a3dbs()).length === 2, "account 3 has a vault");
    const opts2 = await openExtPage("options.html");
    await opts2.waitForSelector(`.row[data-id="${ids.a3}"]`);
    await opts2.hover(`.row[data-id="${ids.a3}"]`);
    await opts2.click(`.row[data-id="${ids.a3}"] [data-act="edit"]`);
    await opts2.click('[data-act="remove"]');
    page = await viaSwitch(() => opts2.click('[data-act="remove"]'));
    eq((await a3dbs()).length, 0, "vault deleted");
    eq((await bgState()).accounts.length, 2, "two accounts left");
    expectAccount(await readWa(page), "15550002222", 40);
  });

  await test("Removing the active account switches to another and discards its session", async () => {
    const popup = await openExtPage("popup.html");
    await popup.waitForSelector(`.row[data-id="${ids.a2}"]`);
    await popup.hover(`.row[data-id="${ids.a2}"]`);
    await popup.click(`.row[data-id="${ids.a2}"] [data-act="edit"]`);
    await popup.click('[data-act="remove"]');
    page = await viaSwitch(() => popup.click('[data-act="remove"]'));
    const s = await bgState();
    eq(s.accounts.map((a) => a.id), [ids.a1], "only account 1 left");
    eq(s.activeId, ids.a1, "account 1 active");
    expectAccount(await readWa(page), "15550001111", 3000);
    const vault = (await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""))).filter((n) => n.startsWith(`mwa:${ids.a2}:`));
    eq(vault.length, 0, "account 2 vault deleted");
  });

  await test("Storage usage + persistence are recorded for the options page", async () => {
    const { storageUsage } = (await ext(() => chrome.storage.local.get("storageUsage"))) as { storageUsage?: { bytes: number } };
    assert(storageUsage && storageUsage.bytes > 0, "usage recorded");
  });

  await test("Switch page renders under strict CSP", async () => {
    // Capture the transient switch page for the docs.
    const popup = await openExtPage("popup.html");
    await popup.click("#add");
    const p = await waTab();
    await p.waitForSelector(".card", { timeout: 10_000 }).catch(() => undefined);
    const bg = await p.$eval(".card", (el) => getComputedStyle(el).borderRadius).catch(() => "");
    eq(bg, "20px", "switch page stylesheet applied");
    await waReady(p);
    page = p;
  });

  await test("No JavaScript errors in WhatsApp, popup or options pages", async () => {
    eq(pageErrors, [], "page errors");
  });
} finally {
  await browser.close();
  server.stop(true);
  await rm(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await Bun.write(
  join(root, "tests/e2e/last-run.json"),
  JSON.stringify({ chrome: chromeVersion, at: new Date().toISOString(), results }, null, 2),
);
process.exit(failed.length ? 1 : 0);

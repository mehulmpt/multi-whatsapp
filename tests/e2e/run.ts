/**
 * End-to-end test: runs the real, unpacked extension (dist/) in Chrome for
 * Testing against a local fake of https://web.whatsapp.com (DNS-mapped to a
 * local HTTPS server with a strict CSP).
 *
 *   bun run test:e2e            # headless
 *   HEADFUL=1 bun run test:e2e  # watch it
 *   CHROME_PATH=/path/to/chrome bun run test:e2e
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { type FakeState, WA, root, startEnv } from "./harness";

const dist = join(root, "dist");
const shots = join(root, "docs/screenshots");

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
const env = await startEnv(dist);
const { browser, extId, chromeVersion, pageErrors, ext, bgState, watchErrors, waTab, waReady, readWa, login, openExtPage, viaSwitch } = env;
console.log(`Chrome: ${env.chrome}\n${chromeVersion}\nFixture: https://web.whatsapp.com → 127.0.0.1:${env.server.port}\n`);
await mkdir(shots, { recursive: true });

try {
  const ids: Record<string, string> = {};

  await test("Manifest V3 extension loads and its service worker starts", async () => {
    const t = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 10_000 });
    assert(t.url() === `chrome-extension://${extId}/background.js` && extId.length === 32, "extension id");
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

  await test("Incremental save keeps added, updated and deleted records exactly", async () => {
    type F = { mutate(): Promise<void>; snapshot(): Promise<string> };
    const fake = (p: Page) => p.evaluate(() => (window as unknown as { __fakeWa: F }).__fakeWa.snapshot());
    const back = (id: string) => async () => {
      const popup = await openExtPage("popup.html");
      await popup.waitForSelector(`.row[data-id="${id}"]`);
      page = await viaSwitch(() => popup.click(`.row[data-id="${id}"]`));
    };
    // A temporary account: first save is a full copy, the second one a diff.
    const popup = await openExtPage("popup.html");
    page = await viaSwitch(() => popup.click("#add"));
    const tmpId = (await bgState()).activeId!;
    await login(page, "15550009999", 300);
    await back(ids.a1!)();
    await back(tmpId)();
    expectAccount(await readWa(page), "15550009999", 300);

    await page.evaluate(() => (window as unknown as { __fakeWa: F }).__fakeWa.mutate());
    const before = await fake(page);
    await back(ids.a1!)(); // ← incremental save of the temporary account
    const ls = (await ext(() => chrome.storage.local.get("lastSwitch"))).lastSwitch as { savedRecords: number };
    assert(ls.savedRecords > 0 && ls.savedRecords < 200, `save wrote only the changes (wrote ${ls.savedRecords})`);
    expectAccount(await readWa(page), "15550001111", 3000);

    await back(tmpId)();
    const after = await fake(page);
    eq(after, before, "identical after round trip");
    const snap = JSON.parse(after) as { nick: string; edited: number; msgs: string[]; chats: string[] };
    eq([snap.nick, snap.edited, snap.msgs.length, snap.chats.length], ["renamed", 1, 201, 28], "mutations present");

    // Clean up: back to account 1, remove the temporary account.
    await back(ids.a1!)();
    const opts = await openExtPage("popup.html");
    await opts.waitForSelector(`.row[data-id="${tmpId}"]`);
    await opts.hover(`.row[data-id="${tmpId}"]`);
    await opts.click(`.row[data-id="${tmpId}"] [data-act="edit"]`);
    await opts.click('[data-act="remove"]');
    page = await viaSwitch(() => opts.click('[data-act="remove"]'));
    eq((await bgState()).accounts.length, 2, "temporary account removed");
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
    const actions = await p.$eval(".actions", (el) => getComputedStyle(el).display).catch(() => "gone");
    assert(actions === "none" || actions === "gone", `Retry/Back buttons must stay hidden while switching (display: ${actions})`);
    await waReady(p);
    page = p;
  });

  await test("No JavaScript errors in WhatsApp, popup or options pages", async () => {
    eq(pageErrors, [], "page errors");
  });
} finally {
  await env.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
await Bun.write(
  join(root, "tests/e2e/last-run.json"),
  JSON.stringify({ chrome: chromeVersion, at: new Date().toISOString(), results }, null, 2),
);
process.exit(failed.length ? 1 : 0);

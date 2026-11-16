/**
 * Switch-speed benchmark against a fake WhatsApp holding ~82k records per
 * account (shaped like a real account). Measures click → WhatsApp loaded.
 *
 *   bun run bench                 # benchmarks dist/
 *   bun run tests/e2e/bench.ts <dist-dir> [rounds]
 */
import { join } from "node:path";
import { root, startEnv } from "./harness";

const dist = process.argv[2] ?? join(root, "dist");
const rounds = Number(process.argv[3] ?? 4);
const env = await startEnv(dist);
const { browser, ext, bgState, waTab, waReady, login, openExtPage, viaSwitch } = env;
type Fake = { bulk(tag: string): Promise<number>; bulkCount(): Promise<Record<string, number>>; churn(tag: string, n: number): Promise<void> };

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
try {
  console.log(`${env.chromeVersion} · ${dist}`);
  let page = await browser.newPage();
  await page.goto("https://web.whatsapp.com/");
  await waReady(page);
  await login(page, "15550001111", 10);
  const n = await page.evaluate(() => (window as unknown as { __fakeWa: Fake }).__fakeWa.bulk("A"));
  const a1 = (await bgState()).activeId!;

  let t0 = performance.now();
  let popup = await openExtPage("popup.html");
  page = await viaSwitch(() => popup.click("#add"));
  const addMs = performance.now() - t0;
  await login(page, "15550002222", 10);
  await page.evaluate(() => (window as unknown as { __fakeWa: Fake }).__fakeWa.bulk("B"));
  const a2 = (await bgState()).activeId!;
  const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);

  const times: number[] = [];
  const phases: unknown[] = [];
  const CHURN = Number(process.env.CHURN ?? 300);
  for (let i = 0; i < rounds; i++) {
    const target = i % 2 === 0 ? a1 : a2;
    // Realistic use between switches: ~CHURN new/updated messages & contacts.
    await page.evaluate((tag, n) => (window as unknown as { __fakeWa: Fake }).__fakeWa.churn(tag, n), i % 2 === 0 ? "B" : "A", CHURN);
    popup = await openExtPage("popup.html");
    await popup.waitForSelector(`.row[data-id="${target}"]`);
    t0 = performance.now();
    page = await viaSwitch(() => popup.click(`.row[data-id="${target}"]`));
    times.push(performance.now() - t0);
    const counts = await page.evaluate(() => (window as unknown as { __fakeWa: Fake }).__fakeWa.bulkCount());
    const sum = Object.values(counts).reduce((x, y) => x + y, 0);
    if (Math.abs(sum - n) > rounds * CHURN) throw new Error(`data check failed after switch ${i}: ${sum} vs ${n}`);
    phases.push((await ext(() => chrome.storage.local.get("lastSwitch"))).lastSwitch);
  }
  const result = {
    recordsPerAccount: n,
    storageMB: Math.round(usage / 1e6),
    addAccountMs: Math.round(addMs),
    switchMs: times.map(Math.round),
    medianSwitchMs: Math.round(median(times)),
    churnPerSwitch: CHURN,
    phases: phases.map((p) => {
      const x = p as Record<string, number> | undefined;
      return x ? `save ${x.saveMs}ms (${x.savedRecords} written) · restore ${x.restoreMs}ms (${x.restoredRecords})` : null;
    }),
  };
  console.log(JSON.stringify(result, null, 2));
  void waTab;
} finally {
  await env.close();
}

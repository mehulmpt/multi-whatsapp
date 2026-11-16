/**
 * Shared harness for the e2e suite and the benchmark: launches Chrome for
 * Testing with the unpacked extension and a fake https://web.whatsapp.com.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

export const root = join(import.meta.dir, "../..");
const fixture = join(import.meta.dir, "fixture");
export const WA = "https://web.whatsapp.com/";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function findChrome(): string {
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


export type FakeState = {
  loggedIn: boolean; phone?: string; secret?: string; keyExtractable?: boolean; blob?: string;
  chats?: number; byTs?: number; messages?: number; tagged?: number; lastWid?: string; token?: string; versions?: number[];
};

export type Env = Awaited<ReturnType<typeof startEnv>>;

export async function startEnv(dist: string) {
  const tmp = await mkdtemp(join(tmpdir(), "mwa-e2e-"));
  const server = startServer(await makeCert(tmp));
  const chrome = findChrome();
  const browser: Browser = await puppeteer.launch({
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
  const chromeVersion = await browser.version();
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 10_000 });
  const extId = new URL(swTarget.url()).host;
  const pageErrors: string[] = [];

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  async function close(): Promise<void> {
    await browser.close().catch(() => undefined);
    server.stop(true);
    await rm(tmp, { recursive: true, force: true });
  }

  return {
    browser, server, chrome, chromeVersion, extId, pageErrors, close,
    ext, bgState, watchErrors, waTab, waReady, readWa, login, openExtPage, viaSwitch,
  };
}

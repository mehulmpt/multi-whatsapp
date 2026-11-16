import { WA_URL, escapeHtml, getState, send } from "../shared/common";
import { avatarHtml, paintAvatars, sheet } from "../shared/dom";
import type { Account, SwitchStats } from "../shared/types";
import { type CopyCounter, clearLive, deleteSlot, restore, saveLive, setBlockedHandler } from "./vault";

const CSS = `
:root { color-scheme: light dark; --bg:#f0f2f5; --card:#ffffff; --fg:#111b21; --muted:#667781; --line:#e9edef; --accent:#00a884; --danger:#ea0038; }
@media (prefers-color-scheme: dark) { :root { --bg:#0b141a; --card:#111b21; --fg:#e9edef; --muted:#8696a0; --line:#222d34; --danger:#f15c6d; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--fg);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
body { display:grid; place-items:center; padding:16px; }
.card { width:min(380px, 100%); background:var(--card); border-radius:20px; padding:32px 28px 26px; text-align:center;
  box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 12px 40px rgba(0,0,0,.08); }
.avatars { display:flex; align-items:center; justify-content:center; gap:14px; margin-bottom:22px; }
.av { width:56px; height:56px; border-radius:50%; display:grid; place-items:center; font-weight:600; font-size:20px; flex:none; }
.av.from { opacity:.45; transform:scale(.82); }
.arrow { width:44px; height:2px; background:var(--line); position:relative; overflow:hidden; border-radius:2px; }
.arrow::after { content:""; position:absolute; inset:0; width:40%; background:var(--accent); animation: slide 1s ease-in-out infinite; }
@keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(250%); } }
h1 { font-size:18px; font-weight:600; margin:0 0 6px; }
.status { color:var(--muted); min-height:20px; font-size:13px; }
.error { color:var(--danger); margin-top:14px; font-size:13px; white-space:pre-wrap; }
.actions { display:flex; gap:10px; justify-content:center; margin-top:18px; }
button { font:inherit; font-weight:600; border:0; border-radius:999px; padding:9px 18px; cursor:pointer; }
.primary { background:var(--accent); color:#fff; }
.ghost { background:transparent; color:var(--accent); box-shadow: inset 0 0 0 1px var(--line); }
.av.blank { background:#8696a0; color:#fff; }
.done .arrow::after { animation:none; width:100%; }
`;

function avatar(a: Account | undefined, cls: string): string {
  return a ? avatarHtml(a.name, a.color, `av ${cls}`) : `<span class="av ${cls} blank">+</span>`;
}

function render(from: Account | undefined, to: Account | undefined, title: string): {
  status: (msg: string) => void;
  fail: (err: string, retry: () => void) => void;
} {
  document.replaceChildren();
  const html = document.createElement("html");
  html.innerHTML = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Switching… · WhatsApp</title></head>
<body><div class="card">
  <div class="avatars">${from ? avatar(from, "from") + '<div class="arrow"></div>' : ""}${avatar(to, "to")}</div>
  <h1>${escapeHtml(title)}</h1>
  <div class="status">Preparing…</div>
  <div class="error" hidden></div>
  <div class="actions" hidden><button class="primary" data-act="retry">Retry</button><button class="ghost" data-act="back">Back to WhatsApp</button></div>
</div></body>`;
  document.append(html);
  document.adoptedStyleSheets = [sheet(CSS)];
  paintAvatars(html);

  const $ = <T extends Element>(s: string) => html.querySelector<T>(s)!;
  return {
    status: (msg) => {
      $(".status").textContent = msg;
    },
    fail: (err, retry) => {
      $(".card").classList.add("done");
      $(".status").textContent = "Something went wrong";
      const e = $<HTMLElement>(".error");
      e.hidden = false;
      e.textContent = err;
      $<HTMLElement>(".actions").hidden = false;
      $<HTMLButtonElement>('[data-act="retry"]').onclick = retry;
      $<HTMLButtonElement>('[data-act="back"]').onclick = () => location.replace(WA_URL);
    },
  };
}

export async function runOpPage(opId: string): Promise<void> {
  const state = await getState();
  const op = state.pendingOp;
  if (!op || op.id !== opId) {
    // Stale/bookmarked URL – just load WhatsApp normally.
    location.replace(WA_URL);
    return;
  }

  const byId = (id: string | null) => state.accounts.find((a) => a.id === id);
  const from = op.discardLive ? undefined : byId(state.activeId);
  const to = byId(op.to);
  const isSwitch = op.to !== state.activeId || !!op.discardLive;
  const title = !isSwitch ? "Cleaning up…" : to ? `Switching to ${to.name}` : "Signing out…";
  const ui = render(from, to, title);

  setBlockedHandler(async () => {
    phase = "Waiting for WhatsApp to release its storage…";
    await send({ type: "unblock-storage" });
  });

  const t0 = performance.now();
  const stats: SwitchStats = { at: Date.now(), totalMs: 0, saveMs: 0, clearMs: 0, restoreMs: 0, savedRecords: 0, restoredRecords: 0 };
  const saved: CopyCounter = { records: 0 };
  const restored: CopyCounter = { records: 0 };
  let phase = "Preparing…";
  const fmt = new Intl.NumberFormat();
  const ticker = window.setInterval(() => {
    const n = phase.startsWith("Saving") ? saved.records : phase.startsWith("Restoring") ? restored.records : 0;
    ui.status(n ? `${phase} ${fmt.format(n)} records` : phase);
  }, 100);
  const step = async <T>(label: string, fn: () => Promise<T>): Promise<[T, number]> => {
    phase = label;
    const s0 = performance.now();
    const out = await fn();
    return [out, Math.round(performance.now() - s0)];
  };

  try {
    // Ask Chrome not to evict this origin's storage under disk pressure: it now
    // holds every saved account, not just a re-downloadable cache. Not awaited
    // up front – it doesn't need to block the switch.
    const persisted = navigator.storage.persist().catch(() => false);

    // Re-read state on every attempt: a retry must not re-save a live session
    // that has already been saved and cleared (activeId is null by then).
    const { activeId } = await getState();
    if (isSwitch) {
      if (activeId && !op.discardLive) {
        [, stats.saveMs] = await step(`Saving ${from?.name ?? "current account"} ·`, () => saveLive(activeId, saved));
      }
      // From here on the live storage belongs to nobody.
      await send({ type: "op-progress", opId, activeId: null });

      [, stats.clearMs] = await step("Clearing…", clearLive);
      if (op.to) {
        const target = op.to;
        [, stats.restoreMs] = await step(`Restoring ${to?.name ?? "account"} ·`, () => restore(target, restored));
      }
      await send({ type: "op-progress", opId, activeId: op.to });
    }
    for (const id of op.deleteSlots ?? []) {
      phase = "Removing saved session…";
      await deleteSlot(id);
    }
    stats.totalMs = Math.round(performance.now() - t0);
    stats.savedRecords = saved.records;
    stats.restoredRecords = restored.records;
    console.info("[multi-whatsapp] switch", stats);
    window.clearInterval(ticker);
    ui.status("Opening WhatsApp…");

    // Bookkeeping doesn't need to delay WhatsApp's start.
    void Promise.all([persisted, navigator.storage.estimate().catch(() => ({ usage: 0 }))]).then(([p, est]) =>
      send({ type: "storage-usage", bytes: est.usage ?? 0, persisted: p }).catch(() => undefined),
    );
    if (isSwitch) void send({ type: "switch-stats", stats }).catch(() => undefined);
    await send({ type: "op-done", opId, ok: true });
    location.replace(WA_URL);
  } catch (e) {
    window.clearInterval(ticker);
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[multi-whatsapp] switch failed", e);
    await send({ type: "op-done", opId, ok: false, error: msg }).catch(() => undefined);
    ui.fail(msg, () => location.reload());
  }
}

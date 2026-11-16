import { COLORS, getState, OP_PARAM, WA_ORIGIN, WA_URL, initials, uid } from "../shared/common";
import type { Account, PendingOp, Request, Response, State } from "../shared/types";

/** An op older than this is considered abandoned and may be replaced. */
const OP_STALE_MS = 90_000;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

async function save(patch: Partial<State> | Record<string, unknown>): Promise<void> {
  await chrome.storage.local.set(patch);
}

function nextName(accounts: Account[]): string {
  let n = accounts.length + 1;
  const taken = new Set(accounts.map((a) => a.name));
  while (taken.has(`Account ${n}`)) n++;
  return `Account ${n}`;
}

function nextColor(accounts: Account[]): string {
  const used = new Set(accounts.map((a) => a.color));
  return COLORS.find((c) => !used.has(c)) ?? COLORS[accounts.length % COLORS.length]!;
}

function newAccount(accounts: Account[], name?: string): Account {
  return {
    id: uid(),
    name: name?.trim() || nextName(accounts),
    color: nextColor(accounts),
    createdAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// WhatsApp tab management + op dispatch
// ---------------------------------------------------------------------------

async function waTabs(): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ url: `${WA_ORIGIN}/*` });
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Pick one WhatsApp tab to run the op in, closing any duplicates – extra tabs
 * hold IndexedDB connections open which would block the database swap
 * (WhatsApp only allows one active tab anyway).
 */
async function primaryWaTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await waTabs();
  if (tabs.length === 0) return null;
  const [lastFocused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const primary = tabs.find((t) => t.id === lastFocused?.id) ?? tabs.find((t) => t.active) ?? tabs[0]!;
  const extra = tabs.filter((t) => t.id !== primary.id).map((t) => t.id!);
  if (extra.length) await chrome.tabs.remove(extra);
  return primary;
}

async function dispatch(op: Omit<PendingOp, "id" | "createdAt">): Promise<void> {
  const state = await getState();
  if (state.pendingOp && Date.now() - state.pendingOp.createdAt < OP_STALE_MS) {
    throw new Error("Another switch is still in progress — give it a second.");
  }
  const pendingOp: PendingOp = { ...op, id: uid(), createdAt: Date.now() };
  await save({ pendingOp });
  const url = `${WA_URL}?${OP_PARAM}=${pendingOp.id}`;
  const tab = await primaryWaTab();
  if (!tab) {
    await chrome.tabs.create({ url, active: true });
    return;
  }
  await chrome.tabs.update(tab.id!, { url, active: true });
  await focusTab(tab);
}

async function openWhatsApp(): Promise<void> {
  const tabs = await waTabs();
  if (tabs[0]) await focusTab(tabs[0]);
  else await chrome.tabs.create({ url: WA_URL });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function switchTo(id: string): Promise<void> {
  const state = await getState();
  if (!state.accounts.some((a) => a.id === id)) throw new Error("Unknown account");
  if (state.activeId === id) return openWhatsApp();
  await dispatch({ to: id });
}

async function switchRelative(delta: number): Promise<void> {
  const { accounts, activeId } = await getState();
  if (accounts.length < 2) return openWhatsApp();
  const idx = accounts.findIndex((a) => a.id === activeId);
  const next = accounts[(((idx < 0 ? 0 : idx) + delta) % accounts.length + accounts.length) % accounts.length]!;
  await switchTo(next.id);
}

async function addAccount(name?: string): Promise<Account> {
  const state = await getState();
  const account = newAccount(state.accounts, name);
  await save({ accounts: [...state.accounts, account] });
  try {
    await dispatch({ to: account.id });
  } catch (e) {
    await save({ accounts: state.accounts });
    throw e;
  }
  return account;
}

/** Claim the current, unassigned live session as a new account. */
async function adopt(name?: string): Promise<Account> {
  const state = await getState();
  const account = newAccount(state.accounts, name);
  await save({ accounts: [...state.accounts, account], activeId: account.id });
  return account;
}

async function removeAccount(id: string): Promise<void> {
  const state = await getState();
  if (!state.accounts.some((a) => a.id === id)) return;
  let accounts = state.accounts.filter((a) => a.id !== id);
  if (state.activeId === id) {
    // Removing the live account: discard its session and move to another one.
    let target = accounts[0];
    if (!target) {
      target = newAccount([]);
      accounts = [target];
    }
    await save({ accounts });
    await dispatch({ to: target.id, discardLive: true, deleteSlots: [id] });
  } else {
    await save({ accounts });
    // The saved session lives in WhatsApp's origin; clean it up there.
    await dispatch({ to: state.activeId, deleteSlots: [id] });
  }
}

async function updateAccount(id: string, patch: { name?: string; color?: string }): Promise<void> {
  const { accounts } = await getState();
  await save({
    accounts: accounts.map((a) =>
      a.id === id
        ? {
            ...a,
            ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 40) } : {}),
            ...(patch.color && (COLORS as readonly string[]).includes(patch.color) ? { color: patch.color } : {}),
          }
        : a,
    ),
  });
}

async function reorder(ids: string[]): Promise<void> {
  const { accounts } = await getState();
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const ordered = ids.map((i) => byId.get(i)).filter((a): a is Account => !!a);
  const rest = accounts.filter((a) => !ids.includes(a.id));
  await save({ accounts: [...ordered, ...rest] });
}

async function recordProfile(phone: string): Promise<void> {
  const { accounts, activeId } = await getState();
  if (!activeId) return;
  const acc = accounts.find((a) => a.id === activeId);
  if (!acc || acc.phone === phone) return;
  await save({ accounts: accounts.map((a) => (a.id === activeId ? { ...a, phone } : a)) });
}

async function opProgress(opId: string, activeId: string | null): Promise<void> {
  const { pendingOp, accounts } = await getState();
  if (pendingOp?.id !== opId) return;
  await save({
    activeId,
    accounts: activeId ? accounts.map((a) => (a.id === activeId ? { ...a, lastUsedAt: Date.now() } : a)) : accounts,
  });
}

async function opDone(opId: string, ok: boolean): Promise<void> {
  const { pendingOp } = await getState();
  if (pendingOp?.id !== opId) return;
  // On failure keep the op around so the switch page can offer a retry.
  if (ok) await save({ pendingOp: null });
  else await save({ pendingOp: { ...pendingOp, createdAt: 0 } });
}

/**
 * A live WhatsApp database can't be deleted while something still holds it
 * open and ignores `versionchange` – in practice WhatsApp's service worker.
 * Unregistering it terminates the worker, which releases the connection; the
 * queued delete then completes. WhatsApp re-registers its worker on next load.
 */
let lastUnblock = 0;
async function unblockStorage(): Promise<void> {
  if (Date.now() - lastUnblock < 3000) return;
  lastUnblock = Date.now();
  await chrome.browsingData.remove({ origins: [WA_ORIGIN] }, { serviceWorkers: true });
}

async function recordStorageUsage(bytes: number, persisted: boolean): Promise<void> {
  await save({ storageUsage: { bytes, persisted, at: Date.now() } });
}

// ---------------------------------------------------------------------------
// Badge: show the active account on the toolbar icon
// ---------------------------------------------------------------------------

async function refreshBadge(): Promise<void> {
  const { accounts, activeId } = await getState();
  const active = accounts.find((a) => a.id === activeId);
  if (accounts.length < 2 && active) {
    await chrome.action.setBadgeText({ text: "" });
  } else if (active) {
    await chrome.action.setBadgeText({ text: initials(active.name).slice(0, 2) });
    await chrome.action.setBadgeBackgroundColor({ color: active.color });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  } else {
    await chrome.action.setBadgeText({ text: accounts.length ? "?" : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#8696a0" });
  }
  await chrome.action.setTitle({ title: active ? `Multi WhatsApp — ${active.name}` : "Multi WhatsApp" });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  if (state.accounts.length === 0) {
    // Adopt whatever session is currently logged in as the first account.
    const first = newAccount([], "Account 1");
    await save({ accounts: [first], activeId: first.id, pendingOp: null });
  }
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(() => void refreshBadge());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ("accounts" in changes || "activeId" in changes)) void refreshBadge();
});

chrome.commands.onCommand.addListener((command) => {
  const run = command === "next-account" ? switchRelative(1) : command === "prev-account" ? switchRelative(-1) : null;
  run?.catch((e: unknown) => console.warn("[multi-whatsapp]", e));
});

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "get-state":
      return getState();
    case "switch":
      return switchTo(req.id);
    case "switch-relative":
      return switchRelative(req.delta);
    case "add":
      return addAccount(req.name);
    case "adopt":
      return adopt(req.name);
    case "update":
      return updateAccount(req.id, req);
    case "remove":
      return removeAccount(req.id);
    case "reorder":
      return reorder(req.ids);
    case "open-whatsapp":
      return openWhatsApp();
    case "profile":
      return recordProfile(req.phone);
    case "op-progress":
      return opProgress(req.opId, req.activeId);
    case "op-done":
      return opDone(req.opId, req.ok);
    case "unblock-storage":
      return unblockStorage();
    case "storage-usage":
      return recordStorageUsage(req.bytes, req.persisted);
    case "switch-stats":
      return save({ lastSwitch: req.stats });
  }
}

chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse: (r: Response) => void) => {
  handle(req).then(
    (data) => sendResponse({ ok: true, data: data ?? null }),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  return true;
});

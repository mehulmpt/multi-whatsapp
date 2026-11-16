import type { Account, Prefs, Request, Response, State } from "./types";

export const WA_ORIGIN = "https://web.whatsapp.com";
export const WA_URL = `${WA_ORIGIN}/`;
export const OP_PARAM = "mwa_op";

export const COLORS = [
  "#25D366", // WhatsApp green
  "#3B82F6", // blue
  "#A855F7", // purple
  "#F97316", // orange
  "#EC4899", // pink
  "#14B8A6", // teal
  "#EAB308", // amber
  "#EF4444", // red
] as const;

export const DEFAULT_PREFS: Prefs = { dockHidden: false, dockTop: 50 };

export async function getPrefs(): Promise<Prefs> {
  const raw = await chrome.storage.local.get(["dockHidden", "dockTop", "storageUsage", "lastSwitch"]);
  return {
    dockHidden: raw.dockHidden === true,
    dockTop: typeof raw.dockTop === "number" ? raw.dockTop : DEFAULT_PREFS.dockTop,
    storageUsage: raw.storageUsage as Prefs["storageUsage"],
    lastSwitch: raw.lastSwitch as Prefs["lastSwitch"],
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = (now - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export async function getState(): Promise<State> {
  const raw = await chrome.storage.local.get(["accounts", "activeId", "pendingOp"]);
  return {
    accounts: (raw.accounts as Account[] | undefined) ?? [],
    activeId: (raw.activeId as string | null | undefined) ?? null,
    pendingOp: (raw.pendingOp as State["pendingOp"] | undefined) ?? null,
  };
}

export function onStateChange(cb: (state: State) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if ("accounts" in changes || "activeId" in changes || "pendingOp" in changes) {
      void getState().then(cb);
    }
  });
}

export async function send<T = unknown>(req: Request): Promise<T> {
  const res = (await chrome.runtime.sendMessage(req)) as Response<T> | undefined;
  if (!res) throw new Error("No response from extension background");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

export function uid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0] ?? "";
  const second = words[1];
  if (/^\+?\d/.test(first)) return first.replace(/\D/g, "").slice(-2);
  // "Account 2" → "A2", "Work Phone" → "WP", "Work" → "W"
  return ((first[0] ?? "") + (second?.[0] ?? "")).toUpperCase();
}

export function formatPhone(phone?: string): string {
  return phone ? `+${phone}` : "";
}

/** Pick a readable text colour (black/white) for a background hex colour. */
export function contrastText(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#111b21" : "#ffffff";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

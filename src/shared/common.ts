import type { Account, Request, Response, State } from "./types";

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

export const DEFAULT_STATE: State = { accounts: [], activeId: null, pendingOp: null };

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
  return ((first[0] ?? "") + (second?.[0] ?? first[1] ?? "")).toUpperCase();
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

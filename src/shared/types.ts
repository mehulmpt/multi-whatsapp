export interface Account {
  id: string;
  name: string;
  color: string;
  /** Phone number detected from WhatsApp Web after login (digits only). */
  phone?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/**
 * A storage operation executed inside the web.whatsapp.com origin (the only
 * place that can read/write WhatsApp's IndexedDB + localStorage).
 */
export interface PendingOp {
  id: string;
  /** Account whose saved session should become live. null = leave live empty. */
  to: string | null;
  /** Do not save the current live session before clearing it (account was removed). */
  discardLive?: boolean;
  /** Vault slots to delete once the switch is done. */
  deleteSlots?: string[];
  createdAt: number;
}

export interface State {
  accounts: Account[];
  /**
   * Which account the live WhatsApp Web storage currently belongs to.
   * null = live storage is not owned by any account (fresh/unassigned).
   */
  activeId: string | null;
  pendingOp: PendingOp | null;
}

export type Request =
  | { type: "get-state" }
  | { type: "switch"; id: string }
  | { type: "switch-relative"; delta: number }
  | { type: "add"; name?: string }
  | { type: "adopt"; name?: string }
  | { type: "update"; id: string; name?: string; color?: string }
  | { type: "remove"; id: string }
  | { type: "reorder"; ids: string[] }
  | { type: "open-whatsapp" }
  | { type: "profile"; phone: string }
  | { type: "op-progress"; opId: string; activeId: string | null }
  | { type: "op-done"; opId: string; ok: boolean; error?: string }
  | { type: "unblock-storage" }
  | { type: "storage-usage"; bytes: number; persisted: boolean };

/** Device-local preferences and diagnostics (chrome.storage.local). */
export interface Prefs {
  dockHidden: boolean;
  /** Vertical position of the in-page switcher, % of viewport height. */
  dockTop: number;
  /** Total bytes WhatsApp Web + saved sessions use in this browser. */
  storageUsage?: { bytes: number; persisted: boolean; at: number };
}

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

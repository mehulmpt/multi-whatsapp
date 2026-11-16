import { COLORS, contrastText, escapeHtml, formatPhone, getState, initials, onStateChange, send } from "../shared/common";
import type { Account, State } from "../shared/types";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const list = $<HTMLUListElement>("#list");
const banner = $("#banner");

let state: State = { accounts: [], activeId: null, pendingOp: null };
let editing: string | null = null;
let confirmRemove = false;
let dragId: string | null = null;

const ICON_EDIT = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>`;

function toast(msg: string): void {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), 3500);
}

async function run(fn: () => Promise<unknown>, closeAfter = false): Promise<void> {
  try {
    await fn();
    if (closeAfter) window.close();
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
  }
}

function avatar(a: Account): string {
  return `<span class="av" style="background:${a.color};color:${contrastText(a.color)}">${escapeHtml(initials(a.name))}</span>`;
}

function rowHtml(a: Account, i: number): string {
  const active = a.id === state.activeId;
  if (editing === a.id) {
    return `<li class="editor" data-id="${a.id}">
      <input type="text" value="${escapeHtml(a.name)}" maxlength="40" aria-label="Account name" />
      <div class="swatches">${COLORS.map(
        (c) => `<button class="swatch ${c === a.color ? "sel" : ""}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`,
      ).join("")}</div>
      <div class="editor-actions">
        <button class="btn remove ${confirmRemove ? "confirm" : ""}" data-act="remove">${confirmRemove ? "Click again to remove" : "Remove"}</button>
        <span class="right"><button class="btn cancel" data-act="cancel">Cancel</button><button class="btn save" data-act="save">Save</button></span>
      </div>
    </li>`;
  }
  const sub = [formatPhone(a.phone), active ? "" : a.lastUsedAt ? `used ${ago(a.lastUsedAt)}` : a.phone ? "" : "not linked yet"]
    .filter(Boolean)
    .join(" · ");
  return `<li class="row ${active ? "active" : ""}" data-id="${a.id}" tabindex="0" draggable="true"
      title="${active ? "Current account" : `Switch to ${escapeHtml(a.name)}`}">
    ${avatar(a)}
    <span class="meta"><div class="name">${escapeHtml(a.name)}</div><div class="sub">${escapeHtml(sub || (active ? "Active now" : ""))}</div></span>
    ${active ? '<span class="pill">Active</span>' : i < 9 ? `<span class="key">${i + 1}</span>` : ""}
    <span class="actions"><button class="icon-btn" data-act="edit" title="Edit">${ICON_EDIT}</button></span>
  </li>`;
}

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function render(): void {
  const { accounts, activeId } = state;
  list.innerHTML = accounts.length
    ? accounts.map(rowHtml).join("")
    : `<li class="empty">No accounts yet.<br>Add one to get started.</li>`;

  const unassigned = !activeId && !state.pendingOp;
  banner.hidden = !unassigned;
  if (unassigned) {
    banner.innerHTML = `The WhatsApp session currently open isn't saved to any account.<br><button data-act="adopt">Save it as a new account</button>`;
  }

  if (editing) {
    const input = list.querySelector<HTMLInputElement>(".editor input");
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }
}

function saveEdit(id: string): void {
  const li = list.querySelector<HTMLElement>(`.editor[data-id="${id}"]`);
  if (!li) return;
  const name = li.querySelector<HTMLInputElement>("input")!.value;
  const color = li.querySelector<HTMLElement>(".swatch.sel")?.dataset.color;
  editing = null;
  render();
  void run(() => send({ type: "update", id, name, color }));
}

// --- events ----------------------------------------------------------------

list.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLElement>("[data-id]");
  if (!li) return;
  const id = li.dataset.id!;
  const btn = target.closest<HTMLElement>("[data-act],[data-color]");

  if (btn?.dataset.color) {
    li.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("sel", s === btn));
    return;
  }
  switch (btn?.dataset.act) {
    case "edit":
      editing = id;
      confirmRemove = false;
      render();
      return;
    case "cancel":
      editing = null;
      render();
      return;
    case "save":
      saveEdit(id);
      return;
    case "remove":
      if (!confirmRemove) {
        confirmRemove = true;
        btn.classList.add("confirm");
        btn.textContent = "Click again to remove";
        return;
      }
      editing = null;
      void run(() => send({ type: "remove", id }), id === state.activeId);
      return;
  }
  if (li.classList.contains("row") && id !== state.activeId) {
    void run(() => send({ type: "switch", id }), true);
  }
});

list.addEventListener("dblclick", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!li) return;
  editing = li.dataset.id!;
  confirmRemove = false;
  render();
});

list.addEventListener("keydown", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
  if (!li) return;
  if (li.classList.contains("editor")) {
    if (e.key === "Enter") saveEdit(li.dataset.id!);
    if (e.key === "Escape") {
      e.preventDefault();
      editing = null;
      render();
    }
    e.stopPropagation();
    return;
  }
  if (e.key === "Enter" && li.dataset.id !== state.activeId) {
    void run(() => send({ type: "switch", id: li.dataset.id! }), true);
  }
});

// Drag to reorder
list.addEventListener("dragstart", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!li) return;
  dragId = li.dataset.id!;
  li.classList.add("dragging");
  e.dataTransfer!.effectAllowed = "move";
});
list.addEventListener("dragover", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!li || !dragId) return;
  e.preventDefault();
  const after = e.offsetY > li.offsetHeight / 2;
  list.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  li.classList.add(after ? "drop-after" : "drop-before");
});
list.addEventListener("drop", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".row");
  if (!li || !dragId) return;
  e.preventDefault();
  const ids = state.accounts.map((a) => a.id).filter((i) => i !== dragId);
  const after = li.classList.contains("drop-after");
  const idx = ids.indexOf(li.dataset.id!);
  ids.splice(after ? idx + 1 : idx, 0, dragId);
  dragId = null;
  void run(() => send({ type: "reorder", ids }));
});
list.addEventListener("dragend", () => {
  dragId = null;
  render();
});

banner.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).dataset.act === "adopt") void run(() => send({ type: "adopt" }));
});

$("#add").addEventListener("click", () => {
  $<HTMLButtonElement>("#add").disabled = true;
  void run(() => send({ type: "add" }), true).finally(() => ($<HTMLButtonElement>("#add").disabled = false));
});
$("#open").addEventListener("click", () => void run(() => send({ type: "open-whatsapp" }), true));

// Number keys 1–9 switch instantly
document.addEventListener("keydown", (e) => {
  if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
  const n = Number(e.key);
  const a = n >= 1 && n <= 9 ? state.accounts[n - 1] : undefined;
  if (a && a.id !== state.activeId) void run(() => send({ type: "switch", id: a.id }), true);
});

// In-page dock toggle
const dockToggle = $<HTMLInputElement>("#dock");
void chrome.storage.local.get("dockHidden").then((p) => (dockToggle.checked = p.dockHidden !== true));
dockToggle.addEventListener("change", () => void chrome.storage.local.set({ dockHidden: !dockToggle.checked }));

// Show the configured next-account shortcut
void chrome.commands.getAll().then((cmds) => {
  const next = cmds.find((c) => c.name === "next-account")?.shortcut;
  $("#shortcut").innerHTML = next ? `<kbd>${escapeHtml(next)}</kbd> next` : "";
});

void getState().then((s) => {
  state = s;
  render();
});
onStateChange((s) => {
  state = s;
  render();
});

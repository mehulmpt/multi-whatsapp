import { COLORS, ago, escapeHtml, formatPhone, getState, onStateChange, send } from "../shared/common";
import { avatarHtml, paintAvatars } from "../shared/dom";
import type { Account, State } from "../shared/types";

const ICON_EDIT = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>`;

export interface AccountListOptions {
  list: HTMLElement;
  /** Shown when the live session doesn't belong to any account. */
  banner: HTMLElement;
  /** Called after a switch/add was dispatched (popup closes itself). */
  onNavigate?: () => void;
  onError: (message: string) => void;
}

export interface AccountList {
  getState: () => State;
  switchTo: (id: string) => void;
  add: () => Promise<void>;
}

export function mountAccountList(opts: AccountListOptions): AccountList {
  const { list, banner } = opts;
  let state: State = { accounts: [], activeId: null, pendingOp: null };
  let editing: string | null = null;
  let confirmRemove = false;
  let dragId: string | null = null;

  const run = async (fn: () => Promise<unknown>, navigates = false): Promise<void> => {
    try {
      await fn();
      if (navigates) opts.onNavigate?.();
    } catch (e) {
      opts.onError(e instanceof Error ? e.message : String(e));
    }
  };

  const switchTo = (id: string) => {
    if (id !== state.activeId) void run(() => send({ type: "switch", id }), true);
  };

  const rowHtml = (a: Account, i: number): string => {
    const active = a.id === state.activeId;
    if (editing === a.id) {
      return `<li class="editor" data-id="${a.id}">
        <input type="text" value="${escapeHtml(a.name)}" maxlength="40" aria-label="Account name" />
        <div class="swatches" role="radiogroup" aria-label="Colour">${COLORS.map(
          (c) =>
            `<button type="button" class="swatch ${c === a.color ? "sel" : ""}" data-color="${c}" data-bg="${c}" role="radio" aria-checked="${c === a.color}" aria-label="Colour ${c}"></button>`,
        ).join("")}</div>
        <div class="editor-actions">
          <button type="button" class="btn remove ${confirmRemove ? "confirm" : ""}" data-act="remove">${confirmRemove ? "Click again to remove" : "Remove"}</button>
          <span class="right"><button type="button" class="btn cancel" data-act="cancel">Cancel</button><button type="button" class="btn save" data-act="save">Save</button></span>
        </div>
      </li>`;
    }
    const detail = active ? "Active now" : a.lastUsedAt ? `Used ${ago(a.lastUsedAt)}` : a.phone ? "" : "Not linked yet";
    const sub = [formatPhone(a.phone), detail].filter(Boolean).join(" · ");
    return `<li class="row ${active ? "active" : ""}" data-id="${a.id}" tabindex="0" draggable="true"
        title="${active ? "Current account" : `Switch to ${escapeHtml(a.name)}`}">
      ${avatarHtml(a.name, a.color)}
      <span class="meta"><span class="name">${escapeHtml(a.name)}</span><span class="sub">${escapeHtml(sub)}</span></span>
      ${active ? '<span class="pill">Active</span>' : i < 9 ? `<span class="key">${i + 1}</span>` : ""}
      <span class="actions"><button type="button" class="icon-btn" data-act="edit" title="Rename or change colour" aria-label="Edit ${escapeHtml(a.name)}">${ICON_EDIT}</button></span>
    </li>`;
  };

  const render = () => {
    const { accounts, activeId } = state;
    list.innerHTML = accounts.length
      ? accounts.map(rowHtml).join("")
      : `<li class="empty">No accounts yet.<br>Add one to get started.</li>`;
    paintAvatars(list);

    const unassigned = !activeId && !state.pendingOp && accounts.length > 0;
    banner.hidden = !unassigned;
    banner.innerHTML = unassigned
      ? `The WhatsApp session open right now isn't saved to any account.<br><button type="button" data-act="adopt">Save it as a new account</button>`
      : "";

    const input = list.querySelector<HTMLInputElement>(".editor input");
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  };

  const startEdit = (id: string) => {
    editing = id;
    confirmRemove = false;
    render();
  };

  const saveEdit = (id: string) => {
    const li = list.querySelector<HTMLElement>(`.editor[data-id="${id}"]`);
    if (!li) return;
    const name = li.querySelector<HTMLInputElement>("input")!.value;
    const color = li.querySelector<HTMLElement>(".swatch.sel")?.dataset.color;
    editing = null;
    render();
    void run(() => send({ type: "update", id, name, color }));
  };

  // --- events ---------------------------------------------------------------
  list.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const li = target.closest<HTMLElement>("[data-id]");
    if (!li) return;
    const id = li.dataset.id!;
    const btn = target.closest<HTMLElement>("[data-act],[data-color]");

    if (btn?.dataset.color) {
      li.querySelectorAll<HTMLElement>(".swatch").forEach((s) => {
        s.classList.toggle("sel", s === btn);
        s.setAttribute("aria-checked", String(s === btn));
      });
      return;
    }
    switch (btn?.dataset.act) {
      case "edit":
        return startEdit(id);
      case "cancel":
        editing = null;
        return render();
      case "save":
        return saveEdit(id);
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
    if (li.classList.contains("row")) switchTo(id);
  });

  list.addEventListener("dblclick", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (li) startEdit(li.dataset.id!);
  });

  list.addEventListener("keydown", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
    if (!li) return;
    if (li.classList.contains("editor")) {
      if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") saveEdit(li.dataset.id!);
      if (e.key === "Escape") {
        e.preventDefault();
        editing = null;
        render();
      }
      e.stopPropagation();
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      switchTo(li.dataset.id!);
    } else if (e.key === "F2") {
      startEdit(li.dataset.id!);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const sib = e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling;
      (sib as HTMLElement | null)?.focus();
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
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    list.querySelectorAll(".drop-before,.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    li.classList.add(after ? "drop-after" : "drop-before");
  });
  list.addEventListener("drop", (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".row");
    if (!li || !dragId) return;
    e.preventDefault();
    const moving = dragId;
    const ids = state.accounts.map((a) => a.id).filter((i) => i !== moving);
    const idx = ids.indexOf(li.dataset.id!);
    if (idx >= 0) ids.splice(li.classList.contains("drop-after") ? idx + 1 : idx, 0, moving);
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

  // Number keys 1–9 switch instantly
  document.addEventListener("keydown", (e) => {
    if (editing || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]")) return;
    const n = Number(e.key);
    const a = n >= 1 && n <= 9 ? state.accounts[n - 1] : undefined;
    if (a) switchTo(a.id);
  });

  const update = (s: State) => {
    state = s;
    // Don't yank an open editor away because some other field changed.
    if (editing && !s.accounts.some((a) => a.id === editing)) editing = null;
    if (!editing) render();
  };
  void getState().then(update);
  onStateChange(update);

  return {
    getState: () => state,
    switchTo,
    add: () => run(() => send({ type: "add" }), true),
  };
}

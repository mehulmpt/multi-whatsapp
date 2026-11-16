import { escapeHtml, formatPhone, getPrefs, getState, onStateChange, send } from "../shared/common";
import { avatarHtml, paintAvatars, sheet } from "../shared/dom";
import type { State } from "../shared/types";

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { --bg:#ffffff; --fg:#111b21; --muted:#667781; --line:#e9edef; --hover:#f5f6f6; --accent:#00a884;
  position: fixed; right: 0; z-index: 2147483000; transform: translateY(-50%);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--fg); }
@media (prefers-color-scheme: dark) { .root { --bg:#233138; --fg:#e9edef; --muted:#8696a0; --line:#2f3b43; --hover:#2a3942; } }
.tab { display:flex; flex-direction:column; align-items:center; gap:6px; padding:8px 6px 6px 8px; background:var(--bg);
  border-radius: 14px 0 0 14px; box-shadow: 0 2px 12px rgba(11,20,26,.18); cursor:pointer; user-select:none; }
.grip { width:16px; height:4px; border-radius:2px; background:var(--line); cursor:ns-resize; }
.av { width:30px; height:30px; border-radius:50%; display:grid; place-items:center; font-weight:600; font-size:12px; flex:none; }
.count { font-size:10px; color:var(--muted); font-weight:600; }
.panel { position:absolute; right:calc(100% + 8px); top:50%; transform:translateY(-50%) translateX(8px); width:260px; background:var(--bg);
  border-radius:14px; box-shadow: 0 6px 30px rgba(11,20,26,.25); padding:6px; opacity:0; pointer-events:none;
  transition: opacity .14s ease, transform .14s ease; }
.root.open .panel { opacity:1; transform:translateY(-50%); pointer-events:auto; }
.head { display:flex; align-items:center; justify-content:space-between; padding:8px 10px 6px; color:var(--muted); font-size:11px;
  font-weight:600; letter-spacing:.04em; text-transform:uppercase; }
.head button { all:unset; cursor:pointer; color:var(--muted); font-size:11px; text-transform:none; letter-spacing:0; font-weight:500; }
.head button:hover { color:var(--fg); }
.list { max-height: 60vh; overflow:auto; }
.item { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:10px; cursor:pointer; border:0; background:none;
  width:100%; text-align:left; color:inherit; font:inherit; }
.item:hover, .item:focus-visible { background:var(--hover); outline:none; }
.item.active { cursor:default; }
.meta { flex:1; min-width:0; }
.name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.sub { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.check { color:var(--accent); font-weight:700; }
.key { color:var(--muted); font-size:11px; border:1px solid var(--line); border-radius:5px; padding:0 5px; }
.sep { height:1px; background:var(--line); margin:6px 4px; }
.add .av { background:transparent; color:var(--accent); border:1.5px dashed var(--accent); font-size:18px; font-weight:400; }
.add .name { color:var(--accent); }
.warn { margin:4px 6px 6px; padding:8px 10px; border-radius:10px; background:rgba(234,179,8,.15); font-size:12px; }
.warn button { all:unset; cursor:pointer; color:var(--accent); font-weight:600; margin-top:4px; display:inline-block; }
.busy { position:absolute; inset:0; border-radius:14px; background:var(--bg); display:grid; place-items:center; color:var(--muted); }
`;

export function mountDock(): void {
  const host = document.createElement("multi-whatsapp-dock");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [sheet(CSS)];
  const root = document.createElement("div");
  root.className = "root";
  shadow.append(root);
  document.documentElement.append(host);

  let state: State | null = null;
  let hidden = false;
  let topPct = 50;
  let closeTimer: number | undefined;

  const render = () => {
    if (!state) return;
    host.style.display = hidden ? "none" : "";
    root.style.top = `${topPct}%`;
    const { accounts, activeId } = state;
    const active = accounts.find((a) => a.id === activeId);
    const items = accounts
      .map((a, i) => {
        const isActive = a.id === activeId;
        return `<button class="item ${isActive ? "active" : ""}" data-id="${a.id}" title="${isActive ? "Current account" : `Switch to ${escapeHtml(a.name)}`}">
          ${avatarHtml(a.name, a.color)}
          <span class="meta"><div class="name">${escapeHtml(a.name)}</div><div class="sub">${escapeHtml(formatPhone(a.phone) || (isActive ? "Active" : "Not linked yet"))}</div></span>
          ${isActive ? '<span class="check">✓</span>' : i < 9 ? `<span class="key">${i + 1}</span>` : ""}
        </button>`;
      })
      .join("");

    root.innerHTML = `
      <div class="tab" title="Multi WhatsApp — switch account">
        <div class="grip" title="Drag to move"></div>
        ${active ? avatarHtml(active.name, active.color) : avatarHtml("?", "#8696a0")}
        <span class="count">${accounts.length}</span>
      </div>
      <div class="panel" role="menu">
        <div class="head"><span>Accounts</span><button data-act="hide" title="Hide the dock (re-enable from the toolbar popup)">Hide</button></div>
        ${active ? "" : `<div class="warn">This session isn't saved to any account yet.<br><button data-act="adopt">Save as new account</button></div>`}
        <div class="list">${items}</div>
        <div class="sep"></div>
        <button class="item add" data-act="add"><span class="av">+</span><span class="meta"><div class="name">Add account</div><div class="sub">Link another number</div></span></button>
      </div>`;
    paintAvatars(root);
  };

  const setBusy = (label: string) => {
    const panel = root.querySelector(".panel");
    if (panel) panel.insertAdjacentHTML("beforeend", `<div class="busy">${escapeHtml(label)}</div>`);
  };

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      root.querySelector(".busy")?.remove();
      console.warn("[multi-whatsapp]", e);
      alertInline(e instanceof Error ? e.message : String(e));
    }
  };

  const alertInline = (msg: string) => {
    const panel = root.querySelector(".panel");
    panel?.insertAdjacentHTML("afterbegin", `<div class="warn">${escapeHtml(msg)}</div>`);
  };

  // --- open / close -------------------------------------------------------
  const open = () => {
    clearTimeout(closeTimer);
    root.classList.add("open");
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => root.classList.remove("open"), 250);
  };
  root.addEventListener("mouseenter", open);
  root.addEventListener("mouseleave", scheduleClose);
  document.addEventListener("keydown", (e) => {
    if (!root.classList.contains("open")) return;
    if (e.key === "Escape") root.classList.remove("open");
    const n = Number(e.key);
    if (n >= 1 && n <= 9 && state?.accounts[n - 1] && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const target = state.accounts[n - 1]!;
      if (target.id !== state.activeId) {
        e.preventDefault();
        e.stopPropagation();
        void act(() => send({ type: "switch", id: target.id }), `Switching to ${target.name}…`);
      }
    }
  }, true);

  // --- clicks -------------------------------------------------------------
  root.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-id],[data-act],.tab");
    if (!el || !state) return;
    if (el.classList.contains("tab")) {
      root.classList.toggle("open");
      return;
    }
    const id = el.dataset.id;
    if (id) {
      const target = state.accounts.find((a) => a.id === id);
      if (target && id !== state.activeId) void act(() => send({ type: "switch", id }), `Switching to ${target.name}…`);
      return;
    }
    switch (el.dataset.act) {
      case "add":
        void act(() => send({ type: "add" }), "Preparing new account…");
        break;
      case "adopt":
        void act(() => send({ type: "adopt" }), "Saving…");
        break;
      case "hide":
        void chrome.storage.local.set({ dockHidden: true });
        break;
    }
  });

  // --- vertical drag via grip --------------------------------------------
  root.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).classList.contains("grip")) return;
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      topPct = Math.min(92, Math.max(8, (ev.clientY / window.innerHeight) * 100));
      root.style.top = `${topPct}%`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      void chrome.storage.local.set({ dockTop: topPct });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  // --- state --------------------------------------------------------------
  const load = async () => {
    const [s, prefs] = await Promise.all([getState(), getPrefs()]);
    state = s;
    hidden = prefs.dockHidden;
    topPct = prefs.dockTop;
    render();
  };
  void load();
  onStateChange((s) => {
    state = s;
    render();
  });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && ("dockHidden" in c || "dockTop" in c)) void load();
  });

  watchProfile();
}

/** Detect the logged-in phone number so accounts get a helpful subtitle. */
function watchProfile(): void {
  let last = "";
  const check = () => {
    for (const key of ["last-wid-md", "last-wid"]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const phone = /(\d{6,})/.exec(raw)?.[1];
      if (phone && phone !== last) {
        last = phone;
        void send({ type: "profile", phone }).catch(() => undefined);
      }
      return;
    }
  };
  check();
  window.setInterval(check, 5000);
}

import { DEFAULT_PREFS, ago, escapeHtml, formatBytes, getPrefs, send } from "../shared/common";
import { mountAccountList } from "../ui/account-list";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

let toastTimer: number | undefined;
function toast(msg: string): void {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 4000);
}

$("#version").textContent = `Version ${chrome.runtime.getManifest().version}`;

const accounts = mountAccountList({
  list: $("#list"),
  banner: $("#banner"),
  onNavigate: () => toast("Switching in your WhatsApp tab…"),
  onError: toast,
});

const addBtn = $<HTMLButtonElement>("#add");
addBtn.addEventListener("click", () => {
  addBtn.disabled = true;
  void accounts.add().finally(() => (addBtn.disabled = false));
});
$("#open").addEventListener("click", () => void send({ type: "open-whatsapp" }).catch((e: Error) => toast(e.message)));
$("#shortcuts").addEventListener("click", () => void chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));

const dock = $<HTMLInputElement>("#dock");
dock.addEventListener("change", () => void chrome.storage.local.set({ dockHidden: !dock.checked }));
$("#reset-dock").addEventListener("click", () => {
  void chrome.storage.local.set({ dockTop: DEFAULT_PREFS.dockTop, dockHidden: false }).then(() => toast("Switcher position reset."));
});

async function renderPrefs(): Promise<void> {
  const prefs = await getPrefs();
  dock.checked = !prefs.dockHidden;
  const u = prefs.storageUsage;
  $("#usage").textContent = u ? formatBytes(u.bytes) : "Not measured yet";
  $("#persist").textContent = u
    ? `${u.persisted ? "Chrome has marked this storage as persistent, so it won't clear it to free up disk space." : "Chrome hasn't granted persistent storage yet. If disk space runs very low, it may clear site data."} Measured ${ago(u.at)}.`
    : "Measured during the next account switch.";
}

async function renderCommands(): Promise<void> {
  const cmds = await chrome.commands.getAll();
  const label: Record<string, string> = {
    _execute_action: "Open the account switcher",
    "next-account": "Next account",
    "prev-account": "Previous account",
  };
  $("#commands").innerHTML = cmds
    .map(
      (c) =>
        `<li><span>${escapeHtml(label[c.name ?? ""] ?? c.description ?? c.name ?? "")}</span>${
          c.shortcut ? `<kbd>${escapeHtml(c.shortcut)}</kbd>` : '<span class="muted">Not set</span>'
        }</li>`,
    )
    .join("");
}

void renderPrefs();
void renderCommands();
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && ("dockHidden" in c || "dockTop" in c || "storageUsage" in c)) void renderPrefs();
});
window.addEventListener("focus", () => void renderCommands());

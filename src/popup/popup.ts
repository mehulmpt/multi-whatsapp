import { escapeHtml, getPrefs, send } from "../shared/common";
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

const accounts = mountAccountList({
  list: $("#list"),
  banner: $("#banner"),
  onNavigate: () => window.close(),
  onError: toast,
});

const addBtn = $<HTMLButtonElement>("#add");
addBtn.addEventListener("click", () => {
  addBtn.disabled = true;
  void accounts.add().finally(() => (addBtn.disabled = false));
});

$("#open").addEventListener("click", () => {
  send({ type: "open-whatsapp" }).then(() => window.close(), (e: Error) => toast(e.message));
});
$("#settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().then(() => window.close());
});

const dockToggle = $<HTMLInputElement>("#dock");
void getPrefs().then((p) => (dockToggle.checked = !p.dockHidden));
dockToggle.addEventListener("change", () => void chrome.storage.local.set({ dockHidden: !dockToggle.checked }));

void chrome.commands.getAll().then((cmds) => {
  const next = cmds.find((c) => c.name === "next-account")?.shortcut;
  $("#shortcut").innerHTML = next ? `<kbd>${escapeHtml(next)}</kbd> next` : "";
});

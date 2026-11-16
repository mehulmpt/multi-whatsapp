import { OP_PARAM } from "../shared/common";
import { mountDock } from "./dock";
import { runOpPage } from "./op-page";

const opId = new URLSearchParams(location.search).get(OP_PARAM);

if (opId && window.top === window) {
  // We run at document_start: stop WhatsApp from loading at all so nothing
  // holds its databases open while we swap them.
  window.stop();
  void runOpPage(opId);
} else if (window.top === window) {
  const start = () => mountDock();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

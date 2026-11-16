// Adversarial service worker: holds a connection to the session DB and
// ignores versionchange, so deleting the DB blocks until the worker dies.
"use strict";
let held = null;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  if (e.data !== "hold") return;
  const r = indexedDB.open("wawc");
  r.onsuccess = () => {
    held = r.result;
    e.ports[0].postMessage("holding");
  };
  r.onerror = () => e.ports[0].postMessage("error");
  // Keep the worker alive while holding the connection.
  e.waitUntil(new Promise((resolve) => setTimeout(resolve, 60_000)));
});

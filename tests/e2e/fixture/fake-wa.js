// A stand-in for WhatsApp Web that stores a "session" the way the real app
// does: several IndexedDB databases (incl. a non-extractable CryptoKey),
// plus localStorage. Exposes window.__fakeWa for the test harness.
"use strict";

const SESSION_DB = { name: "wawc", version: 5 };
const MODEL_DB = { name: "model-storage", version: 12 };

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function open({ name, version }) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (name === SESSION_DB.name) {
        db.createObjectStore("user", { keyPath: "id" });
        db.createObjectStore("keys"); // out-of-line keys
        const chats = db.createObjectStore("chats", { autoIncrement: true });
        chats.createIndex("byTs", "ts");
      } else {
        const msg = db.createObjectStore("message", { keyPath: ["chat", "seq"] });
        msg.createIndex("chat", "chat");
        msg.createIndex("tags", "tags", { multiEntry: true });
      }
    };
    r.onsuccess = () => resolve(r.result); // deliberately ignores versionchange, like a busy app
    r.onerror = () => reject(r.error);
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

let session, model;

async function login(phone, messages) {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const secret = new TextEncoder().encode(`secret-of-${phone}`);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, secret);

  await tx(session, ["user", "keys", "chats"], "readwrite", (t) => {
    t.objectStore("user").put({ id: "me", phone, iv, cipher, blob: new Blob([`avatar-${phone}`]) });
    t.objectStore("keys").put(key, "enc");
    for (let i = 0; i < 25; i++) t.objectStore("chats").put({ ts: Date.now() + i, title: `${phone} chat ${i}` });
  });
  await tx(model, ["message"], "readwrite", (t) => {
    const s = t.objectStore("message");
    for (let i = 0; i < messages; i++) {
      s.put({ chat: `c${i % 7}`, seq: i, body: `${phone} message ${i}`, tags: [`t${i % 3}`, "all"] });
    }
  });
  localStorage.setItem("last-wid-md", JSON.stringify(`${phone}:7@c.us`));
  localStorage.setItem("WAToken", `token-${phone}`);
  render();
}

async function read() {
  const user = await tx(session, ["user"], "readonly", (t) => req(t.objectStore("user").get("me"))).then((p) => p);
  if (!user) return { loggedIn: false, ls: localStorage.length };
  const u = await user;
  const key = await tx(session, ["keys"], "readonly", (t) => req(t.objectStore("keys").get("enc"))).then((p) => p);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.iv }, key, u.cipher);
  const chats = await tx(session, ["chats"], "readonly", (t) => req(t.objectStore("chats").count())).then((p) => p);
  const byTs = await tx(session, ["chats"], "readonly", (t) => req(t.objectStore("chats").index("byTs").count())).then((p) => p);
  const messages = await tx(model, ["message"], "readonly", (t) => req(t.objectStore("message").count())).then((p) => p);
  const tagged = await tx(model, ["message"], "readonly", (t) => req(t.objectStore("message").index("tags").count("all"))).then((p) => p);
  return {
    loggedIn: true,
    phone: u.phone,
    secret: new TextDecoder().decode(plain),
    keyExtractable: key.extractable,
    blob: await u.blob.text(),
    chats,
    byTs,
    messages,
    tagged,
    lastWid: localStorage.getItem("last-wid-md"),
    token: localStorage.getItem("WAToken"),
    versions: [session.version, model.version],
  };
}

async function render() {
  const state = await read();
  document.querySelector("#status").textContent = state.loggedIn ? `Logged in as +${state.phone}` : "Scan the QR code";
}

/** Make the service worker grab a DB connection it never releases. */
async function holdFromServiceWorker() {
  const reg = await navigator.serviceWorker.register("/sw.js");
  const sw = reg.active ?? reg.installing ?? reg.waiting;
  if (sw.state !== "activated") await new Promise((r) => sw.addEventListener("statechange", () => sw.state === "activated" && r()));
  const ch = new MessageChannel();
  const held = new Promise((r) => (ch.port1.onmessage = (e) => r(e.data)));
  sw.postMessage("hold", [ch.port2]);
  return held;
}

(async () => {
  session = await open(SESSION_DB);
  model = await open(MODEL_DB);
  await render();
  window.__fakeWa = { login, read, holdFromServiceWorker, ready: true };
})();

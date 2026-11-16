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

/**
 * Benchmark data shaped like a real ~80k-record WhatsApp Web account
 * (record counts per store measured on a real account; value sizes approximate,
 * random payloads so Chrome's compression can't flatter the numbers).
 */
const BULK = {
  "bench-model": { contact: [11236, 400], message: [9966, 1500], "device-list": [7124, 200], reactions: [2818, 250], misc: [13346, 250] },
  "bench-wawc": { logs: [23810, 300] },
  "bench-fts": { "fts-v3-index": [8554, 900] },
  "bench-signal": { "identity-store": [4248, 150], "prekey-store": [534, 300], "session-store": [271, 2000] },
};

function payload(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil((len * 3) / 4)));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).slice(0, len);
}

async function bulk(tag) {
  let total = 0;
  for (const [dbName, stores] of Object.entries(BULK)) {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, 7);
      r.onupgradeneeded = () => {
        for (const name of Object.keys(stores)) {
          const os = name === "logs" ? r.result.createObjectStore(name, { autoIncrement: true }) : r.result.createObjectStore(name, { keyPath: "id" });
          // Index counts measured on real WhatsApp Web: message 20, contact 6, reactions 4, most others 0.
          const nIdx = { message: 20, contact: 6, reactions: 4 }[name] ?? 0;
          for (let i = 0; i < nIdx; i++) os.createIndex(`i${i}`, i % 3 === 2 ? [`f${i}`, "group"] : `f${i}`);
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (const [name, [count, size]] of Object.entries(stores)) {
      for (let start = 0; start < count; start += 5000) {
        await tx(db, [name], "readwrite", (t) => {
          const os = t.objectStore(name);
          for (let i = start; i < Math.min(count, start + 5000); i++) {
            const v = { group: i % 50, tag, data: payload(size) };
            for (let f = 0; f < 20; f++) v[`f${f}`] = f % 2 ? `${tag}${(i * (f + 3)) % 997}` : (i * (f + 7)) % 4999;
            if (name === "logs") os.put(v);
            else os.put({ id: `${tag}-${String(i).padStart(6, "0")}`, ...v });
          }
        });
      }
      total += count;
    }
    db.close();
  }
  return total;
}

/** Simulate a few minutes of use: new + updated messages, receipts, logs, deletions. */
async function churn(tag, n) {
  const db = await new Promise((resolve) => {
    const r = indexedDB.open("bench-model");
    r.onsuccess = () => resolve(r.result);
  });
  await tx(db, ["message", "contact", "device-list"], "readwrite", (t) => {
    const fields = (i) => Object.fromEntries(Array.from({ length: 20 }, (_, f) => [`f${f}`, f % 2 ? `${tag}${(i * (f + 5)) % 997}` : (i * (f + 11)) % 4999]));
    for (let i = 0; i < n; i++) t.objectStore("message").put({ id: `${tag}-new-${Date.now()}-${i}`, group: i % 50, tag, data: payload(1500), ...fields(i) });
    for (let i = 0; i < n; i++) t.objectStore("contact").put({ id: `${tag}-${String(i * 7).padStart(6, "0")}`, group: 1, tag, data: payload(400), ...fields(i) });
    for (let i = 0; i < n / 5; i++) t.objectStore("device-list").delete(`${tag}-${String(i * 3).padStart(6, "0")}`);
  });
  db.close();
}

/** Mutate the main session DBs: update, add and delete records. */
async function mutate() {
  await tx(session, ["user", "chats"], "readwrite", (t) => {
    t.objectStore("user").get("me").onsuccess = (e) => t.objectStore("user").put({ ...e.target.result, nick: "renamed" });
    for (let i = 0; i < 3; i++) t.objectStore("chats").put({ ts: Date.now() + 1000 + i, title: "new chat" });
  });
  await tx(model, ["message"], "readwrite", (t) => {
    const s = t.objectStore("message");
    for (let i = 0; i < 100; i++) s.delete([`c${i % 7}`, i]);
    s.put({ chat: "c0", seq: 7, body: "edited message", tags: ["all"] });
    s.delete(["c0", 7]); // deleted above already; re-put after:
    s.put({ chat: "c0", seq: 7, body: "edited message", tags: ["all", "edited"] });
  });
}

async function snapshot() {
  const u = await tx(session, ["user"], "readonly", (t) => req(t.objectStore("user").get("me"))).then((p) => p);
  const chats = await tx(session, ["chats"], "readonly", (t) => req(t.objectStore("chats").getAll())).then((p) => p);
  const msgs = await tx(model, ["message"], "readonly", (t) => req(t.objectStore("message").getAll())).then((p) => p);
  const edited = await tx(model, ["message"], "readonly", (t) => req(t.objectStore("message").index("tags").count("edited"))).then((p) => p);
  return JSON.stringify({ nick: u?.nick ?? null, chats: chats.map((c) => c.title), msgs: msgs.map((m) => `${m.chat}/${m.seq}/${m.body}`), edited });
}

async function bulkCount() {
  const out = {};
  for (const [dbName, stores] of Object.entries(BULK)) {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open(dbName);
      r.onsuccess = () => resolve(r.result);
    });
    const names = Object.keys(stores).filter((n) => db.objectStoreNames.contains(n));
    for (const n of names) out[n] = await tx(db, [n], "readonly", (t) => req(t.objectStore(n).count())).then((p) => p);
    db.close();
  }
  return out;
}

(async () => {
  session = await open(SESSION_DB);
  model = await open(MODEL_DB);
  await render();
  window.__fakeWa = { login, read, holdFromServiceWorker, bulk, bulkCount, churn, mutate, snapshot, ready: true };
})();

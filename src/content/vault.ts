/**
 * Session vault.
 *
 * WhatsApp Web keeps its whole session (encryption keys, chats, settings) in
 * IndexedDB + localStorage of https://web.whatsapp.com. Content scripts share
 * that origin's storage, so we can snapshot the "live" databases into
 * per-account copies (prefixed `mwa:<accountId>:`) and restore them later.
 *
 * Everything stays inside the WhatsApp origin. That matters: WhatsApp stores
 * non-extractable CryptoKey objects, which can be structured-cloned between
 * IndexedDB databases of the same origin but can never be exported elsewhere.
 */

const PREFIX = "mwa:";
const META_DB = "mwa-vault";
const META_STORE = "slots";
const CHUNK = 500;
const BLOCKED_TIMEOUT_MS = 20_000;

interface IndexSchema {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}
interface StoreSchema {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: IndexSchema[];
}
interface DbSchema {
  name: string;
  version: number;
  stores: StoreSchema[];
}
interface SlotMeta {
  accountId: string;
  savedAt: number;
  dbs: DbSchema[];
  localStorage: Record<string, string>;
}

export type Progress = (message: string) => void;

// ---------------------------------------------------------------------------
// Promise wrappers
// ---------------------------------------------------------------------------

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function open(name: string, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    r.onupgradeneeded = () => upgrade?.(r.result);
    r.onsuccess = () => {
      const db = r.result;
      // Never be the connection that blocks someone else.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error ?? new Error(`Failed to open ${name}`));
    r.onblocked = () => reject(new Error(`Opening "${name}" is blocked — close other WhatsApp tabs and retry.`));
  });
}

/**
 * Called once when a live database delete is blocked by another connection
 * (e.g. WhatsApp's service worker). Should try to make that holder go away.
 */
let onBlocked: (() => Promise<void>) | null = null;
export function setBlockedHandler(fn: () => Promise<void>): void {
  onBlocked = fn;
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    // A blocked delete stays queued and completes by itself once the other
    // connection closes, so we keep waiting rather than issuing a new one.
    const timer = setTimeout(
      () => reject(new Error(`"${name}" is still in use by another WhatsApp tab or window. Close it and retry.`)),
      BLOCKED_TIMEOUT_MS,
    );
    r.onblocked = () => {
      void onBlocked?.().catch((e: unknown) => console.warn("[multi-whatsapp] unblock failed", e));
    };
    r.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    r.onerror = () => {
      clearTimeout(timer);
      reject(r.error ?? new Error(`Failed to delete ${name}`));
    };
  });
}

// ---------------------------------------------------------------------------
// Schema + copy
// ---------------------------------------------------------------------------

function readSchema(db: IDBDatabase): DbSchema {
  const names = Array.from(db.objectStoreNames);
  const stores: StoreSchema[] = [];
  if (names.length) {
    const tx = db.transaction(names, "readonly");
    for (const n of names) {
      const s = tx.objectStore(n);
      stores.push({
        name: n,
        keyPath: s.keyPath,
        autoIncrement: s.autoIncrement,
        indexes: Array.from(s.indexNames).map((i) => {
          const idx = s.index(i);
          return { name: i, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry };
        }),
      });
    }
  }
  return { name: db.name, version: db.version, stores };
}

async function createWithSchema(name: string, schema: DbSchema): Promise<IDBDatabase> {
  await deleteDb(name);
  return open(name, Math.max(1, schema.version), (db) => {
    for (const s of schema.stores) {
      const store = db.createObjectStore(s.name, {
        keyPath: s.keyPath ?? undefined,
        autoIncrement: s.autoIncrement,
      });
      for (const i of s.indexes) store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry });
    }
  });
}

async function copyStore(src: IDBDatabase, dst: IDBDatabase, store: StoreSchema): Promise<number> {
  let lower: IDBValidKey | undefined;
  let total = 0;
  for (;;) {
    const range = lower === undefined ? undefined : IDBKeyRange.lowerBound(lower, true);
    const rtx = src.transaction(store.name, "readonly");
    const os = rtx.objectStore(store.name);
    // Both calls walk the same key order inside one transaction → aligned.
    const [keys, values] = await Promise.all([req(os.getAllKeys(range, CHUNK)), req(os.getAll(range, CHUNK))]);
    if (keys.length === 0) break;

    const wtx = dst.transaction(store.name, "readwrite");
    const ws = wtx.objectStore(store.name);
    for (let i = 0; i < keys.length; i++) {
      if (store.keyPath === null) ws.put(values[i], keys[i]);
      else ws.put(values[i]);
    }
    await done(wtx);

    total += keys.length;
    lower = keys[keys.length - 1];
    if (keys.length < CHUNK) break;
  }
  return total;
}

async function copyDb(srcName: string, dstName: string, schema: DbSchema): Promise<void> {
  const src = await open(srcName);
  try {
    const dst = await createWithSchema(dstName, schema);
    try {
      for (const s of schema.stores) await copyStore(src, dst, s);
    } finally {
      dst.close();
    }
  } finally {
    src.close();
  }
}

// ---------------------------------------------------------------------------
// Live databases + slot metadata
// ---------------------------------------------------------------------------

async function liveDbNames(): Promise<string[]> {
  const all = await indexedDB.databases();
  return all
    .map((d) => d.name)
    .filter((n): n is string => !!n && !n.startsWith(PREFIX) && n !== META_DB);
}

function slotDbName(accountId: string, dbName: string): string {
  return `${PREFIX}${accountId}:${dbName}`;
}

async function withMeta<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open(META_DB, 1, (d) => {
    if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE, { keyPath: "accountId" });
  });
  try {
    const tx = db.transaction(META_STORE, mode);
    const result = await req(fn(tx.objectStore(META_STORE)));
    await done(tx);
    return result;
  } finally {
    db.close();
  }
}

const getMeta = (id: string) => withMeta("readonly", (s) => s.get(id) as IDBRequest<SlotMeta | undefined>);
const putMeta = (m: SlotMeta) => withMeta("readwrite", (s) => s.put(m));
const delMeta = (id: string) => withMeta("readwrite", (s) => s.delete(id));

function readLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null) out[k] = localStorage.getItem(k) ?? "";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Snapshot the live session into the account's slot (replacing any older one). */
export async function saveLive(accountId: string, progress: Progress): Promise<void> {
  const names = await liveDbNames();
  const previous = await getMeta(accountId);
  const schemas: DbSchema[] = [];

  for (const name of names) {
    progress(`Saving ${name}…`);
    const db = await open(name);
    const schema = readSchema(db);
    db.close();
    await copyDb(name, slotDbName(accountId, name), schema);
    schemas.push(schema);
  }

  // Drop slot databases that no longer exist live.
  for (const old of previous?.dbs ?? []) {
    if (!names.includes(old.name)) await deleteDb(slotDbName(accountId, old.name));
  }

  await putMeta({ accountId, savedAt: Date.now(), dbs: schemas, localStorage: readLocalStorage() });
}

/** Wipe WhatsApp's live storage so the page starts logged-out. */
export async function clearLive(progress: Progress): Promise<void> {
  progress("Clearing current session…");
  for (const name of await liveDbNames()) await deleteDb(name);
  localStorage.clear();
  sessionStorage.clear();
}

/** Restore an account's slot into live storage. Returns false if it has none. */
export async function restore(accountId: string, progress: Progress): Promise<boolean> {
  const meta = await getMeta(accountId);
  if (!meta) return false;
  for (const schema of meta.dbs) {
    progress(`Restoring ${schema.name}…`);
    await copyDb(slotDbName(accountId, schema.name), schema.name, schema);
  }
  for (const [k, v] of Object.entries(meta.localStorage)) localStorage.setItem(k, v);
  return true;
}

export async function deleteSlot(accountId: string): Promise<void> {
  const meta = await getMeta(accountId);
  const all = await indexedDB.databases();
  const prefix = `${PREFIX}${accountId}:`;
  const names = new Set([
    ...(meta?.dbs.map((d) => slotDbName(accountId, d.name)) ?? []),
    ...all.map((d) => d.name).filter((n): n is string => !!n?.startsWith(prefix)),
  ]);
  for (const n of names) await deleteDb(n);
  await delMeta(accountId);
}

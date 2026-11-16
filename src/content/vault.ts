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

import { same } from "./same";

const PREFIX = "mwa:";
const META_DB = "mwa-vault";
const META_STORE = "slots";
/** Records per read/write transaction. */
const CHUNK = 1000;
/** Object stores copied concurrently (bounds memory: ~2 chunks in flight each). */
const PARALLEL_STORES = 8;
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

/** Running count of records copied, for progress + stats. */
export interface CopyCounter {
  records: number;
}

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

interface Chunk {
  keys: IDBValidKey[];
  values: unknown[];
}
const EMPTY: Chunk = { keys: [], values: [] };

type RecordsStore = IDBObjectStore & {
  getAllRecords?: (o: { query?: IDBKeyRange | null; count?: number }) => IDBRequest<{ key: IDBValidKey; value: unknown }[]>;
};

/** Read up to CHUNK records after `after` (exclusive), in key order. */
async function readChunk(db: IDBDatabase, store: string, after?: IDBValidKey): Promise<Chunk> {
  const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true);
  const os = db.transaction(store, "readonly").objectStore(store) as RecordsStore;
  if (typeof os.getAllRecords === "function") {
    // Chrome 141+: keys and values in one pass.
    const recs = await req(os.getAllRecords({ query: range, count: CHUNK }));
    return { keys: recs.map((r) => r.key), values: recs.map((r) => r.value) };
  }
  // Both calls walk the same key order inside one transaction → aligned.
  const [keys, values] = await Promise.all([req(os.getAllKeys(range, CHUNK)), req(os.getAll(range, CHUNK))]);
  return { keys, values };
}

async function writeChunk(db: IDBDatabase, store: StoreSchema, chunk: Chunk, durability: IDBTransactionDurability): Promise<void> {
  const tx = db.transaction(store.name, "readwrite", { durability });
  const os = tx.objectStore(store.name);
  for (let i = 0; i < chunk.keys.length; i++) {
    if (store.keyPath === null) os.put(chunk.values[i], chunk.keys[i]);
    else os.put(chunk.values[i]);
  }
  await done(tx);
}

/** Tiny semaphore so many stores can copy concurrently without unbounded memory. */
function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * Copy one store, pipelined: while chunk N is being written to `dst`, chunk
 * N+1 is already being read from `src`. Returns the last record written (used
 * for the durability barrier).
 */
async function copyStore(
  src: IDBDatabase,
  dst: IDBDatabase,
  store: StoreSchema,
  counter: CopyCounter,
): Promise<Chunk> {
  let chunk = await readChunk(src, store.name);
  let last = EMPTY;
  while (chunk.keys.length > 0) {
    const more = chunk.keys.length === CHUNK;
    const [, next] = await Promise.all([
      writeChunk(dst, store, chunk, "relaxed"),
      more ? readChunk(src, store.name, chunk.keys[chunk.keys.length - 1]) : Promise.resolve(EMPTY),
    ]);
    counter.records += chunk.keys.length;
    last = { keys: chunk.keys.slice(-1), values: chunk.values.slice(-1) };
    chunk = next;
  }
  return last;
}

async function copyDb(
  srcName: string,
  dstName: string,
  schema: DbSchema,
  run: ReturnType<typeof limiter>,
  counter: CopyCounter,
): Promise<void> {
  const src = await open(srcName);
  try {
    const dst = await createWithSchema(dstName, schema);
    try {
      const lasts = await Promise.all(schema.stores.map((s) => run(() => copyStore(src, dst, s, counter))));
      // Chunks were written with relaxed durability (no fsync each). Before the
      // caller relies on this copy – e.g. deletes the source – force a durable
      // commit by re-writing one record with strict durability.
      const i = lasts.findIndex((c) => c.keys.length > 0);
      if (i >= 0) await writeChunk(dst, schema.stores[i]!, lasts[i]!, "strict");
    } finally {
      dst.close();
    }
  } finally {
    src.close();
  }
}

// ---------------------------------------------------------------------------
// Incremental sync (live → existing slot)
// ---------------------------------------------------------------------------

/** Forward-only, chunked, prefetching reader over a store in key order. */
class RecordStream {
  private chunk: Chunk = EMPTY;
  private i = 0;
  private exhausted = false;
  private pending: Promise<Chunk> | null;

  constructor(private db: IDBDatabase, private store: string) {
    this.pending = readChunk(db, store);
  }

  /** Make sure the current record is buffered (or the stream is known to be done). */
  async fill(): Promise<void> {
    if (this.i < this.chunk.keys.length || this.exhausted) return;
    if (this.pending === null) {
      this.exhausted = true;
      return;
    }
    this.chunk = await this.pending;
    this.i = 0;
    // A short chunk is the last one; otherwise prefetch the next while this one is consumed.
    this.pending =
      this.chunk.keys.length === CHUNK ? readChunk(this.db, this.store, this.chunk.keys[this.chunk.keys.length - 1]) : null;
    if (this.chunk.keys.length === 0) this.exhausted = true;
  }

  /** Only meaningful right after fill(). */
  get done(): boolean {
    return this.i >= this.chunk.keys.length && (this.exhausted || this.pending === null);
  }
  get key(): IDBValidKey {
    return this.chunk.keys[this.i]!;
  }
  get value(): unknown {
    return this.chunk.values[this.i];
  }
  advance(): void {
    this.i++;
  }
}

type Op = { del: false; key: IDBValidKey; value: unknown } | { del: true; key: IDBValidKey };

async function writeOps(db: IDBDatabase, store: StoreSchema, ops: Op[], durability: IDBTransactionDurability): Promise<void> {
  const tx = db.transaction(store.name, "readwrite", { durability });
  const os = tx.objectStore(store.name);
  for (const op of ops) {
    if (op.del) os.delete(op.key);
    else if (store.keyPath === null) os.put(op.value, op.key);
    else os.put(op.value);
  }
  await done(tx);
}

/**
 * Make `dst` (a previous snapshot) identical to `src` (live) by merging both
 * stores in key order and writing only the differences. Reads are ~4× cheaper
 * than writes, and between switches only a small fraction of records change.
 * Idempotent, so it also repairs a snapshot left half-written by a crash.
 * Returns the last op written (for the durability barrier), or null.
 */
async function syncStore(src: IDBDatabase, dst: IDBDatabase, store: StoreSchema, counter: CopyCounter): Promise<Op | null> {
  const a = new RecordStream(src, store.name);
  const b = new RecordStream(dst, store.name);
  let ops: Op[] = [];
  let inflight: Promise<void> = Promise.resolve();
  let last: Op | null = null;

  const flush = async () => {
    if (ops.length === 0) return;
    const batch = ops;
    ops = [];
    last = batch[batch.length - 1]!;
    counter.records += batch.length;
    await inflight; // keep write order
    inflight = writeOps(dst, store, batch, "relaxed");
  };

  for (;;) {
    await Promise.all([a.fill(), b.fill()]);
    if (a.done && b.done) break;
    const c = a.done ? 1 : b.done ? -1 : indexedDB.cmp(a.key, b.key);
    if (c < 0) {
      ops.push({ del: false, key: a.key, value: a.value });
      a.advance();
    } else if (c > 0) {
      ops.push({ del: true, key: b.key });
      b.advance();
    } else {
      if (!same(a.value, b.value)) ops.push({ del: false, key: a.key, value: a.value });
      a.advance();
      b.advance();
    }
    if (ops.length >= CHUNK) await flush();
  }
  await flush();
  await inflight;
  return last;
}

async function syncDb(name: string, slotName: string, schema: DbSchema, run: ReturnType<typeof limiter>, counter: CopyCounter): Promise<void> {
  const src = await open(name);
  try {
    const dst = await open(slotName);
    try {
      const lasts = await Promise.all(schema.stores.map((s) => run(() => syncStore(src, dst, s, counter))));
      // Durability barrier, as in copyDb: re-apply one op with strict durability.
      const i = lasts.findIndex((op) => op !== null);
      if (i >= 0) await writeOps(dst, schema.stores[i]!, [lasts[i]!], "strict");
    } finally {
      dst.close();
    }
  } finally {
    src.close();
  }
}

const schemaKey = (s: DbSchema) => JSON.stringify([s.version, s.stores]);

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

/**
 * Snapshot the live session into the account's slot. If the slot already has
 * an earlier snapshot with the same schema, only the differences are written;
 * otherwise the database is copied in full.
 */
export async function saveLive(accountId: string, counter: CopyCounter = { records: 0 }): Promise<void> {
  const names = await liveDbNames();
  const previous = await getMeta(accountId);
  const existing = new Map((await indexedDB.databases()).map((d) => [d.name, d.version]));
  const run = limiter(PARALLEL_STORES);

  const schemas = await Promise.all(
    names.map(async (name) => {
      const db = await open(name);
      const schema = readSchema(db);
      db.close();
      const slot = slotDbName(accountId, name);
      const prev = previous?.dbs.find((d) => d.name === name);
      if (prev && schemaKey(prev) === schemaKey(schema) && existing.get(slot) === schema.version) {
        await syncDb(name, slot, schema, run, counter);
      } else {
        await copyDb(name, slot, schema, run, counter);
      }
      return schema;
    }),
  );

  // Drop slot databases that no longer exist live.
  await Promise.all(
    (previous?.dbs ?? []).filter((old) => !names.includes(old.name)).map((old) => deleteDb(slotDbName(accountId, old.name))),
  );

  await putMeta({ accountId, savedAt: Date.now(), dbs: schemas, localStorage: readLocalStorage() });
}

/** Wipe WhatsApp's live storage so the page starts logged-out. */
export async function clearLive(): Promise<void> {
  await Promise.all((await liveDbNames()).map(deleteDb));
  localStorage.clear();
  sessionStorage.clear();
}

/** Restore an account's slot into live storage. Returns false if it has none. */
export async function restore(accountId: string, counter: CopyCounter = { records: 0 }): Promise<boolean> {
  const meta = await getMeta(accountId);
  if (!meta) return false;
  const run = limiter(PARALLEL_STORES);
  await Promise.all(meta.dbs.map((schema) => copyDb(slotDbName(accountId, schema.name), schema.name, schema, run, counter)));
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
  await Promise.all([...names].map(deleteDb));
  await delMeta(accountId);
}

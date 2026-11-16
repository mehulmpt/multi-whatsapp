/**
 * Conservative structural equality for values read back from IndexedDB.
 *
 * Used to skip re-writing records that haven't changed. It must never report
 * two different values as equal, because that would leave stale data in a
 * saved session. Reporting equal values as different is harmless: it only
 * costs one extra write. So anything we can't compare cheaply and exactly
 * (Blob, File, CryptoKey, Map, Set, RegExp, boxed primitives, class instances)
 * counts as "changed".
 */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true; // primitives incl. NaN, ±0, bigint
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const proto = Object.getPrototypeOf(a) as object | null;
  if (proto !== Object.getPrototypeOf(b)) return false;

  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (i in a !== i in bb) return false; // holes
      if (!same(a[i], bb[i])) return false;
    }
    return sameOwnKeys(a, bb, true);
  }

  if (a instanceof ArrayBuffer) return sameBytes(new Uint8Array(a), new Uint8Array(b as ArrayBuffer));
  if (ArrayBuffer.isView(a)) {
    const bv = b as ArrayBufferView;
    return a.byteLength === bv.byteLength && sameBytes(
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
      new Uint8Array(bv.buffer, bv.byteOffset, bv.byteLength),
    );
  }
  if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime());

  if (proto === Object.prototype || proto === null) return sameOwnKeys(a, b, false);

  return false; // Blob, CryptoKey, Map, Set, … → treat as changed
}

function sameOwnKeys(a: object, b: object, arrayExtrasOnly: boolean): boolean {
  const ka = Object.keys(a).filter((k) => !arrayExtrasOnly || !/^\d+$/.test(k));
  const kb = Object.keys(b).filter((k) => !arrayExtrasOnly || !/^\d+$/.test(k));
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false;
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

import { describe, expect, test } from "bun:test";
import { same } from "../../src/content/same";

const clone = <T>(v: T): T => structuredClone(v);

describe("same() — equal values (any answer is safe, but these should be equal for speed)", () => {
  test.each([
    ["primitives", [1, "a", true, null, undefined, 10n]],
    ["NaN", Number.NaN],
    ["nested object", { a: 1, b: { c: [1, 2, { d: "x" }] }, e: null }],
    ["array", [1, [2, [3]], { x: 1 }]],
    ["ArrayBuffer", new Uint8Array([1, 2, 3]).buffer],
    ["typed arrays", { u8: new Uint8Array([1, 2]), f64: new Float64Array([1.5, -0]), i32: new Int32Array([7]) }],
    ["DataView", new DataView(new Uint8Array([9, 8, 7]).buffer)],
    ["Date", new Date(1_700_000_000_000)],
    ["key order differs", { a: 1, b: 2 }],
    ["WhatsApp-like message", { id: "true_123@c.us_ABC", t: 1700000000, body: "hi", ack: 3, mediaKey: new Uint8Array(32).fill(7), tags: ["a"] }],
  ])("%s", (_name, v) => {
    expect(same(v, clone(v))).toBe(true);
  });

  test("null-prototype objects compare by content", () => {
    const mk = () => Object.assign(Object.create(null), { a: 1, b: [2] });
    expect(same(mk(), mk())).toBe(true);
  });

  test("key order doesn't matter", () => {
    expect(same({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
});

describe("same() — different values must NEVER be equal", () => {
  test.each([
    ["number", 1, 2],
    ["+0 / -0", 0, -0],
    ["string vs number", "1", 1],
    ["null vs undefined", null, undefined],
    ["null vs object", null, {}],
    ["bigint", 1n, 2n],
    ["missing key", { a: 1 }, { a: 1, b: 2 }],
    ["undefined-valued key vs missing", { a: undefined }, {}],
    ["nested change", { a: { b: [1, 2, 3] } }, { a: { b: [1, 2, 4] } }],
    ["array length", [1, 2], [1, 2, 3]],
    ["array hole vs undefined", [, 1], [undefined, 1]], // eslint-disable-line no-sparse-arrays
    ["array vs object", [1], { 0: 1 }],
    ["ArrayBuffer bytes", new Uint8Array([1, 2, 3]).buffer, new Uint8Array([1, 2, 4]).buffer],
    ["ArrayBuffer length", new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2, 0]).buffer],
    ["typed array kind", new Uint8Array([1, 2]), new Int8Array([1, 2])],
    ["typed array bytes", new Uint8Array([1, 2]), new Uint8Array([1, 3])],
    ["typed array view offset", new Uint8Array([0, 1, 2]).subarray(1), new Uint8Array([1, 3])],
    ["Float64 -0 vs 0", new Float64Array([-0]), new Float64Array([0])],
    ["Date", new Date(1), new Date(2)],
    ["Date vs number", new Date(1), 1],
    ["object vs Date", {}, new Date(0)],
  ])("%s", (_name, a, b) => {
    expect(same(a, b)).toBe(false);
    expect(same(b, a)).toBe(false);
  });

  test("uncomparable types are always treated as changed, even when identical in content", () => {
    expect(same(new Map([[1, 2]]), new Map([[1, 2]]))).toBe(false);
    expect(same(new Set([1]), new Set([1]))).toBe(false);
    expect(same(new Blob(["x"]), new Blob(["x"]))).toBe(false);
    expect(same(/a/, /a/)).toBe(false);
    expect(same(new String("a"), new String("a"))).toBe(false); // eslint-disable-line no-new-wrappers
    class K { x = 1; }
    expect(same(new K(), new K())).toBe(false);
  });

  test("extra non-index properties on arrays are compared", () => {
    const a = Object.assign([1], { extra: 1 });
    const b = Object.assign([1], { extra: 2 });
    expect(same(a, b)).toBe(false);
  });
});

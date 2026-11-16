import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { renderIcon } from "../../scripts/icons";

test.each([16, 32, 48, 128])("renders a valid %ipx RGBA PNG", (size) => {
  const png = renderIcon(size);
  expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset);
  expect(view.getUint32(16)).toBe(size); // IHDR width
  expect(view.getUint32(20)).toBe(size); // IHDR height
  expect(png[25]).toBe(6); // colour type RGBA
  const idatLen = view.getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  expect(raw.length).toBe(size * (size * 4 + 1));
  // corners are transparent (rounded), centre is opaque
  expect(raw[1 + 3]).toBe(0);
  const mid = Math.floor(size / 2) * (size * 4 + 1) + 1 + Math.floor(size / 2) * 4;
  expect(raw[mid + 3]).toBe(255);
});

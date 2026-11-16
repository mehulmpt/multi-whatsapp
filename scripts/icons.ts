/**
 * Renders the extension icon to PNG at build time (no image deps):
 * a WhatsApp-green rounded square with two overlapping chat bubbles.
 */
import { deflateSync } from "node:zlib";

type RGBA = [number, number, number, number];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(size: number, pixels: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// Signed-distance helpers in unit space (0..1)
const roundRect = (x: number, y: number, half: number, r: number) => {
  const qx = Math.abs(x - 0.5) - half + r;
  const qy = Math.abs(y - 0.5) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) - r;
const triangle = (x: number, y: number, a: [number, number], b: [number, number], c: [number, number]) => {
  const s = (p: [number, number], q: [number, number]) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return (d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0) ? 1 : -1;
};

function shade(x: number, y: number): RGBA {
  if (roundRect(x, y, 0.5, 0.22) > 0) return [0, 0, 0, 0];
  // vertical gradient #2BE07A → #0E9F6E
  const t = y;
  let col: RGBA = [Math.round(43 + (14 - 43) * t), Math.round(224 + (159 - 224) * t), Math.round(122 + (110 - 122) * t), 255];

  // back bubble (translucent white)
  const back = Math.min(circle(x, y, 0.62, 0.4, 0.2), triangle(x, y, [0.72, 0.5], [0.84, 0.66], [0.62, 0.58]));
  if (back < 0) col = mix(col, [255, 255, 255, 255], 0.55);
  // front bubble (solid white) with a ring cut-out around it for separation
  const frontC = circle(x, y, 0.42, 0.57, 0.24);
  const front = Math.min(frontC, triangle(x, y, [0.24, 0.66], [0.17, 0.85], [0.38, 0.78]));
  if (front < 0.035 && back < 0 && front >= 0) col = [Math.round(43 + (14 - 43) * t), Math.round(224 + (159 - 224) * t), Math.round(122 + (110 - 122) * t), 255];
  if (front < 0) col = [255, 255, 255, 255];
  // three dots inside the front bubble
  for (const dx of [-0.09, 0, 0.09]) if (circle(x, y, 0.42 + dx, 0.57, 0.03) < 0) col = [14, 159, 110, 255];
  return col;
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return [0, 1, 2, 3].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGBA;
}

export function renderIcon(size: number): Uint8Array {
  const SS = 4; // supersampling for anti-aliasing
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (y * size + x) * 4;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round(a / (SS * SS));
    }
  }
  return encodePng(size, px);
}

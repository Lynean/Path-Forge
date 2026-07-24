// Generates a simple PathForge app icon (a small node-graph) as build/icon.ico,
// with no image-library dependency: hand-rolled RGBA -> PNG -> single-entry ICO.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const S = 256;
const BG = [17, 34, 28];       // dark green
const FG = [70, 220, 135];     // bright green (nodes + edges)
const px = Buffer.alloc(S * S * 4);

const setPx = (x, y, [r, g, b]) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
};

for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) setPx(x, y, BG);

const distSeg = (px_, py_, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px_ - ax) * dx + (py_ - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px_ - (ax + t * dx), py_ - (ay + t * dy));
};

const nodes = [[84, 96], [176, 84], [126, 182]];
const edges = [[0, 1], [0, 2], [1, 2]];

for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  for (const [a, b] of edges) {
    if (distSeg(x, y, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]) < 6) { setPx(x, y, FG); break; }
  }
}
for (const [nx, ny] of nodes) {
  for (let y = -26; y <= 26; y++) for (let x = -26; x <= 26; x++) {
    const d = Math.hypot(x, y);
    if (d < 24) setPx(nx + x, ny + y, FG);
    else if (d < 26) setPx(nx + x, ny + y, BG);
  }
}

// --- encode PNG ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, y * S * 4 + S * 4); }
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);

// --- wrap as ICO (single 256x256 PNG entry) ---
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; entry[1] = 0; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([dir, entry, png]);

const out = resolve(dirname(fileURLToPath(import.meta.url)), "build", "icon.ico");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, ico);
console.log(`Wrote ${out} (${ico.length} bytes)`);

// QR code as a PNG image (email programs do not show SVG). No dependencies except the QR matrix library.
import qrcode from './qrcode.cjs';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const chunk = (type, data) => { const td = cat(new TextEncoder().encode(type), data); return cat(u32(data.length), td, u32(crc32(td))); };
function adler32(buf) { let a = 1, b = 0; for (const x of buf) { a = (a + x) % 65521; b = (b + a) % 65521; } return ((b << 16) | a) >>> 0; }

// zlib stream made of "stored" (uncompressed) blocks: valid PNG, no compression library needed.
function zlibStored(raw) {
  const parts = [new Uint8Array([0x78, 0x01])];
  for (let i = 0; i < raw.length || i === 0; i += 65535) {
    const blk = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    parts.push(new Uint8Array([last, blk.length & 255, blk.length >>> 8, ~blk.length & 255, (~blk.length >>> 8) & 255]), blk);
    if (last) break;
  }
  parts.push(u32(adler32(raw)));
  return cat(...parts);
}

export function qrPng(text, scale = 8, quiet = 4) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), size = (n + quiet * 2) * scale, rowBytes = Math.ceil(size / 8);
  const raw = new Uint8Array((rowBytes + 1) * size).fill(0xff); // filter byte 0 + all white (bit 1 = white)
  for (let y = 0; y < size; y++) raw[y * (rowBytes + 1)] = 0; // PNG filter type "none" for every row
  for (let y = 0; y < size; y++) {
    const my = Math.floor(y / scale) - quiet;
    if (my < 0 || my >= n) continue;
    const base = y * (rowBytes + 1) + 1;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      if (mx >= 0 && mx < n && q.isDark(my, mx)) raw[base + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  const ihdr = cat(u32(size), u32(size), new Uint8Array([1, 0, 0, 0, 0])); // 1-bit grayscale
  return cat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibStored(raw)), chunk('IEND', new Uint8Array(0)));
}

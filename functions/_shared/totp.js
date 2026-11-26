// Authenticator-app codes (RFC 6238): works with Google Authenticator, Microsoft Authenticator, 1Password, etc.
import { hmacBytes, timingEq } from './util.js';

const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += A[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = A.indexOf(ch);
    if (i < 0) continue;
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newSecret() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return base32Encode(b);
}

export async function totpAt(secret, timeMs, digits = 6) {
  const counter = Math.floor(timeMs / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter);
  const h = await hmacBytes(base32Decode(secret), msg, 'SHA-1');
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

// Accept the previous, current and next 30-second window (clock drift).
export async function totpVerify(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  let ok = false;
  for (const d of [-30000, 0, 30000]) {
    if (timingEq(await totpAt(secret, now + d), c)) ok = true;
  }
  return ok;
}

export const otpauthUri = (secret, account) =>
  `otpauth://totp/CarryOff:${encodeURIComponent(account)}?secret=${secret}&issuer=CarryOff&digits=6&period=30`;

// Small helpers shared by all server functions. No dependencies.
const enc = new TextEncoder();

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export function toB64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(str) {
  const p = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacBytes(secret, data, hash = 'SHA-256') {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? enc.encode(secret) : secret,
    { name: 'HMAC', hash },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data));
}

// Compare two strings without leaking where they differ.
export function timingEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Uniform random digits (rejection sampling, no modulo bias).
export function randDigits(n) {
  let out = '';
  const buf = new Uint32Array(1);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4294967290) out += String(buf[0] % 10);
  }
  return out;
}
export function randRef(prefix, n) {
  const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  let s = prefix;
  for (const b of buf) s += al[b % al.length];
  return s;
}

export const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
export const normEmail = (s) => String(s || '').trim().toLowerCase();
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function readJson(request, maxBytes = 20000) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large');
  try {
    const v = JSON.parse(text || '{}');
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

export class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail; // optional, safe-to-show explanation (never a key or personal data)
  }
}

// Reject cross-site POSTs. Browsers always send Origin on POST.
export function requireSameOrigin(request) {
  const origin = request.headers.get('origin');
  const host = new URL(request.url).origin;
  if (origin && origin !== host) throw new HttpError(403, 'bad_origin');
}

// Wrap a handler so errors become clean JSON and nothing internal leaks.
export function handler(fn) {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.code, ...(e.detail ? { detail: e.detail } : {}) }, e.status);
      console.error('unhandled', e && e.stack ? e.stack : e);
      return json({ ok: false, error: 'server_error', detail: String((e && e.message) || e).replace(/(sk|rk|pk|whsec)_\w+|sb_secret_\S+/g, '[key]').slice(0, 160) }, 500); // detail is a temporary debugging aid
    }
  };
}

export function needEnv(env, names) {
  for (const n of names) if (!env[n]) throw new HttpError(503, 'not_configured');
}

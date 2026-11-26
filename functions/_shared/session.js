// Signed session cookies. The server checks the signature on every request.
import { fromB64u, hmacBytes, timingEq, toB64u, HttpError } from './util.js';

const COOKIE = '__Host-co_session'; // __Host- = Secure, path "/", no Domain: cannot be set by sub-domains

export const LIFETIME = {
  partner: 30 * 24 * 3600,   // partners stay logged in 30 days (fewer login emails)
  owner: 8 * 3600,
  owner_pending: 10 * 60,    // between email code and authenticator code
};

export async function makeToken(env, role, sub) {
  const exp = Math.floor(Date.now() / 1000) + LIFETIME[role];
  const payload = toB64u(new TextEncoder().encode(JSON.stringify({ r: role, s: sub, e: exp })));
  const sig = toB64u(await hmacBytes(env.SESSION_SECRET, payload));
  return { token: `${payload}.${sig}`, maxAge: LIFETIME[role] };
}

export async function readToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expect = toB64u(await hmacBytes(env.SESSION_SECRET, payload));
  if (!timingEq(sig, expect)) return null;
  try {
    const d = JSON.parse(new TextDecoder().decode(fromB64u(payload)));
    if (!d.e || d.e < Math.floor(Date.now() / 1000)) return null;
    return { role: d.r, sub: d.s };
  } catch {
    return null;
  }
}

export function cookieHeader(token, maxAge) {
  return `${COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
export const clearCookie = () => cookieHeader('', 0);

export async function getSession(env, request) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return readToken(env, m ? m.slice(COOKIE.length + 1) : '');
}

export async function requireRole(env, request, role) {
  const s = await getSession(env, request);
  if (!s || s.role !== role) throw new HttpError(401, 'not_logged_in');
  return s;
}

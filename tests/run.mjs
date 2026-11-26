// Run with: node tests/run.mjs
// Exercises every endpoint against an in-memory fake of Supabase (PostgREST) and Resend.
import assert from 'node:assert/strict';
import { totpAt, base32Encode, base32Decode } from '../functions/_shared/totp.js';
import * as partnerSend from '../functions/api/auth/partner/send.js';
import * as partnerVerify from '../functions/api/auth/partner/verify.js';
import * as ownerSend from '../functions/api/auth/owner/send.js';
import * as ownerVerify from '../functions/api/auth/owner/verify.js';
import * as ownerTotp from '../functions/api/auth/owner/totp.js';
import * as me from '../functions/api/me.js';
import * as logout from '../functions/api/auth/logout.js';
import * as apply from '../functions/api/apply.js';

const ORIGIN = 'https://carryoff.eu';
const env = {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', SESSION_SECRET: 'x'.repeat(40),
  RESEND_API_KEY: 're_test', OWNER_EMAIL: 'Owner@Example.com',
};

// ---------- fake backends ----------
const tables = { partners: [], partner_applications: [], login_codes: [], owner_settings: [], email_log: [] };
const outbox = [];
let resendFails = false;
let idc = 1;
function matches(row, k, v) {
  const [op, ...r] = v.split('.'); const val = r.join('.');
  const x = row[k];
  if (op === 'eq') return String(x) === val;
  if (op === 'gte') return String(x) >= val;
  if (op === 'gt') return String(x) > val;
  throw new Error('fake: unsupported op ' + op);
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === 'api.resend.com') {
    if (resendFails) return new Response('boom', { status: 500 });
    outbox.push(JSON.parse(init.body));
    return new Response('{"id":"1"}', { status: 200 });
  }
  const table = u.pathname.split('/').pop();
  const t = tables[table]; if (!t) return new Response('no table', { status: 404 });
  assert.equal(init.headers.apikey, 'sb_secret_test');
  assert.equal(init.headers.authorization, undefined, 'new-style keys must not be sent as Bearer');
  const filters = [...u.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict'].includes(k));
  let rows = t.filter((r) => filters.every(([k, v]) => matches(r, k, v)));
  if (init.method === 'GET') {
    if (u.searchParams.get('order')) { const [c, d] = u.searchParams.get('order').split('.'); rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : 1) * (d === 'desc' ? -1 : 1)); }
    if (u.searchParams.get('limit')) rows = rows.slice(0, +u.searchParams.get('limit'));
    return new Response(JSON.stringify(rows));
  }
  if (init.method === 'POST') {
    const row = { id: table === 'owner_settings' ? undefined : idc++, created_at: new Date().toISOString(), used: false, attempts: 0, totp_enabled: false, totp_fails: 0, ...JSON.parse(init.body) };
    if (table === 'owner_settings') row.id = row.id ?? 1;
    t.push(row); return new Response(JSON.stringify([row]), { status: 201 });
  }
  if (init.method === 'PATCH') { rows.forEach((r) => Object.assign(r, JSON.parse(init.body))); return new Response(JSON.stringify(rows)); }
  throw new Error('fake: method');
};

// ---------- helpers ----------
const post = (mod, body, cookie) => mod.onRequestPost({ env, request: new Request(ORIGIN + '/api/x', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }) });
const getMe = (cookie) => me.onRequestGet({ env, request: new Request(ORIGIN + '/api/me', { headers: cookie ? { cookie } : {} }) });
const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];
const lastCode = () => /(\d{6})/.exec(outbox.at(-1).text)[1];
let passed = 0;
const ok = (name) => { passed++; console.log('  ok  ' + name); };

// ---------- TOTP (official RFC 6238 test vector, SHA-1, 8 digits) ----------
{
  const secret = base32Encode(new TextEncoder().encode('12345678901234567890'));
  assert.equal(await totpAt(secret, 59000, 8), '94287082');
  assert.equal(await totpAt(secret, 1111111109000, 8), '07081804');
  assert.deepEqual([...base32Decode(secret)], [...new TextEncoder().encode('12345678901234567890')]);
  ok('TOTP matches RFC 6238 test vectors');
}

// ---------- partner login ----------
tables.partners.push({ id: 'mosaic', name: 'Mosaic Café', email: 'mosaic@example.com', active: true });
tables.partners.push({ id: 'old', name: 'Closed', email: 'old@example.com', active: false });
{
  let r = await post(partnerSend, { email: 'nobody@example.com' });
  assert.equal((await r.json()).ok, true); assert.equal(outbox.length, 0);
  r = await post(partnerSend, { email: 'old@example.com' }); assert.equal(outbox.length, 0);
  ok('unknown or inactive partner: same answer, no email sent');

  r = await post(partnerSend, { email: ' Mosaic@Example.com ' });
  assert.equal((await r.json()).ok, true); assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to[0], 'mosaic@example.com'); assert.match(outbox[0].from, /carryoff\.eu/);
  const code = lastCode();
  assert.ok(!JSON.stringify(tables.login_codes).includes(code), 'code must not be stored in clear text');
  ok('partner gets a 6-digit code by email, stored hashed');

  r = await post(partnerVerify, { email: 'mosaic@example.com', code: code === '000000' ? '111111' : '000000' });
  assert.equal(r.status, 401); assert.equal(r.headers.get('set-cookie'), null);
  r = await post(partnerVerify, { email: 'mosaic@example.com', code });
  const body = await r.json(); assert.equal(body.partner.id, 'mosaic');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=2592000/);
  const cookie = cookieOf(r);
  assert.equal((await (await getMe(cookie)).json()).partner.id, 'mosaic');
  ok('correct code logs in for 30 days with a secure cookie; /api/me recognises it');

  r = await post(partnerVerify, { email: 'mosaic@example.com', code });
  assert.equal(r.status, 401); ok('a code works only once');

  const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await (await getMe(tampered)).json()).role, null);
  assert.equal((await (await getMe('')).json()).role, null);
  ok('forged or missing cookie is not logged in');

  const lo = await post(logout, {}); assert.match(lo.headers.get('set-cookie'), /Max-Age=0/); ok('logout clears the cookie');
}

// ---------- brute force and rate limits ----------
{
  outbox.length = 0; tables.login_codes.length = 0;
  await post(partnerSend, { email: 'mosaic@example.com' });
  const real = lastCode();
  const wrongs = ['000001', '000002', '000003', '000004', '000005'].filter((c) => c !== real);
  for (const w of wrongs) await post(partnerVerify, { email: 'mosaic@example.com', code: w });
  for (let i = 0; i < 6 - wrongs.length; i++) await post(partnerVerify, { email: 'mosaic@example.com', code: '999999' });
  const r = await post(partnerVerify, { email: 'mosaic@example.com', code: real });
  assert.equal(r.status, 401); ok('after 5 wrong tries even the right code is refused');

  tables.login_codes.length = 0; outbox.length = 0;
  for (let i = 0; i < 8; i++) await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal(outbox.length, 5); ok('max 5 login emails per address per hour');
}

// ---------- CSRF ----------
{
  const r = await partnerSend.onRequestPost({ env, request: new Request(ORIGIN + '/api/x', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }) });
  assert.equal(r.status, 403); ok('cross-site POST is rejected');
}

// ---------- owner login: email code + authenticator ----------
{
  tables.login_codes.length = 0; outbox.length = 0;
  await post(ownerSend, { email: 'attacker@example.com' }); assert.equal(outbox.length, 0);
  await post(ownerSend, { email: 'owner@example.com' }); assert.equal(outbox.length, 1);
  ok('only the OWNER_EMAIL address can get an owner code (case-insensitive)');

  let r = await post(ownerVerify, { email: 'owner@example.com', code: lastCode() });
  let body = await r.json(); assert.equal(body.next, 'setup'); assert.match(body.uri, /^otpauth:\/\/totp\/CarryOff:owner%40example\.com\?secret=[A-Z2-7]+/);
  const pending = cookieOf(r);
  assert.equal((await (await getMe(pending)).json()).role, null);
  ok('step 1 gives only a pending session and the one-time authenticator setup');

  assert.equal((await post(ownerTotp, { code: '123456' })).status, 401);
  assert.equal((await post(ownerTotp, { code: '123456' }, '')).status, 401);
  const secret = tables.owner_settings[0].totp_secret;
  const good = await totpAt(secret, Date.now());
  r = await post(ownerTotp, { code: good === '123456' ? '654321' : '123456' }, pending); assert.equal(r.status, 401);
  r = await post(ownerTotp, { code: good }, pending); assert.equal(r.status, 200);
  const ownerCookie = cookieOf(r);
  assert.equal((await (await getMe(ownerCookie)).json()).role, 'owner');
  assert.equal(tables.owner_settings[0].totp_enabled, true);
  ok('authenticator code completes the owner login (8-hour session)');

  // second login: no setup secret is shown again
  tables.login_codes.length = 0; outbox.length = 0;
  await post(ownerSend, { email: 'owner@example.com' });
  r = await post(ownerVerify, { email: 'owner@example.com', code: lastCode() });
  body = await r.json(); assert.equal(body.next, 'totp'); assert.equal(body.secret, undefined); assert.equal(body.uri, undefined);
  ok('after setup the secret is never shown again');

  // partner session cannot act as owner
  const pr = await post(partnerVerify, { email: 'mosaic@example.com', code: await (async () => { tables.login_codes.length = 0; outbox.length = 0; await post(partnerSend, { email: 'mosaic@example.com' }); return lastCode(); })() });
  assert.equal((await post(ownerTotp, { code: good }, cookieOf(pr))).status, 401);
  ok('a partner session cannot be used for the owner step');

  // lockout after 5 wrong authenticator codes
  const pend2 = cookieOf(r);
  const bad = good === '000000' ? '000001' : '000000';
  for (let i = 0; i < 5; i++) await post(ownerTotp, { code: bad }, pend2);
  r = await post(ownerTotp, { code: await totpAt(secret, Date.now()) }, pend2);
  assert.equal(r.status, 429); ok('5 wrong authenticator codes lock the login for 15 minutes');
}

// ---------- partner application ----------
{
  outbox.length = 0;
  const good = { name: 'Blue Door Hostel', type: 'Hotel or hostel', address: 'ul. Slivnitsa 1, Varna', contact: 'Ivan', phone: '+359 88 123 4567', email: 'Ivan@Blue.example', cap_pack: 10, cap_med: 5, cap_large: 2, opens: '09:00', closes: '18:00', days: [1, 2, 3] };
  let r = await post(apply, good); const b = await r.json();
  assert.equal(b.ok, true); assert.match(b.ref, /^P-[A-Z2-9]{4}$/);
  assert.equal(tables.partner_applications[0].email, 'ivan@blue.example');
  assert.equal(outbox.at(-1).to[0], 'Owner@Example.com'); assert.match(outbox.at(-1).html, /Blue Door Hostel/);
  ok('application is saved and the owner is emailed');

  outbox.length = 0;
  r = await post(apply, { ...good, name: '<script>alert(1)</script>' });
  assert.ok(!outbox.at(-1).html.includes('<script>')); ok('HTML in applications is escaped in the email');

  assert.equal((await post(apply, { ...good, closes: '08:00' })).status, 400);
  assert.equal((await post(apply, { ...good, email: 'nope' })).status, 400);
  const n = tables.partner_applications.length;
  await post(apply, { ...good, website: 'http://spam' }); assert.equal(tables.partner_applications.length, n);
  ok('invalid input rejected; bot honeypot ignored');

  r = await post(apply, good); r = await post(apply, good);
  assert.equal((await post(apply, good)).status, 429); ok('same email limited to 3 applications a day');
}

// ---------- email failures and daily limit ----------
{
  tables.email_log.length = 0; tables.login_codes.length = 0; outbox.length = 0;
  resendFails = true;
  let r = await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal((await r.json()).ok, true);
  assert.equal(tables.email_log.at(-1).status, 'failed'); assert.match(tables.email_log.at(-1).error, /resend 500/);
  resendFails = false; ok('failed send does not crash and is logged');

  tables.email_log.length = 0; tables.login_codes.length = 0; outbox.length = 0;
  for (let i = 0; i < 79; i++) tables.email_log.push({ id: 1000 + i, to_email: 'x@x', kind: 'login_code', status: 'sent', created_at: new Date().toISOString() });
  await post(partnerSend, { email: 'mosaic@example.com' });
  const warn = outbox.find((m) => /daily emails used/.test(m.subject));
  assert.ok(warn, 'warning email'); assert.equal(warn.to[0], 'Owner@Example.com');
  const before = outbox.length;
  tables.login_codes.length = 0; await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal(outbox.filter((m) => /daily emails used/.test(m.subject)).length, 1); ok('owner warned once at 80 emails in a day');

  for (let i = 0; i < 25; i++) tables.email_log.push({ id: 2000 + i, to_email: 'x@x', kind: 'login_code', status: 'sent', created_at: new Date().toISOString() });
  const n0 = outbox.length; tables.login_codes.length = 0; await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal(outbox.length, n0); assert.equal(tables.email_log.at(-1).status, 'blocked'); ok('sending stops cleanly at the 100/day limit');
}

// ---------- not configured ----------
{
  const saved = { ...env }; delete env.RESEND_API_KEY;
  const r = await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal(r.status, 503); Object.assign(env, saved); ok('missing settings give a clean "not configured" answer');
}
console.log(`\n${passed} checks passed`);

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
import * as checkout from '../functions/api/checkout.js';
import * as webhook from '../functions/api/stripe-webhook.js';
import * as bookingApi from '../functions/api/booking.js';
import * as qrApi from '../functions/api/qr.js';
import { createHmac } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { nowInVarna } from '../functions/_shared/pricing.js';

const ORIGIN = 'https://carryoff.eu';
const env = {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', SESSION_SECRET: 'x'.repeat(40),
  RESEND_API_KEY: 're_test', OWNER_EMAIL: 'Owner@Example.com', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
};

// ---------- fake backends ----------
const tables = { partners: [], partner_applications: [], login_codes: [], owner_settings: [], email_log: [], bookings: [] };
const outbox = [];
const stripeCalls = [];
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
  if (u.host === 'api.stripe.com') {
    assert.equal(init.headers.authorization, 'Bearer sk_test_x');
    const p = new URLSearchParams(init.body); stripeCalls.push(Object.fromEntries(p));
    return new Response(JSON.stringify({ id: 'cs_test_' + stripeCalls.length, url: 'https://checkout.stripe.com/c/pay/cs_test_' + stripeCalls.length }), { status: 200 });
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


// ---------- stage 2: payments and bookings ----------
{
  tables.partners.push({ id: 'aurora', name: 'Hotel Aurora', email: 'a@example.com', active: true, paused: false, address: 'Sample address 1', lat: 43.2, lng: 27.9 });
  tables.partners.push({ id: 'paused', name: 'Paused', email: 'p@example.com', active: true, paused: true });
  tables.email_log.length = 0; outbox.length = 0;
  const today = nowInVarna().date;
  const day = new Date(Date.parse(today + 'T00:00:00Z') + 2 * 864e5).toISOString().slice(0, 10);
  const good = { partner: 'aurora', name: 'Ann Lee', email: 'Ann@Example.com', phone: '+359 881234567', agree: true, items: { pack: 0, med: 1, large: 0 }, drop: { date: day, time: '10:00' }, pick: { date: day, time: '12:00' } };
  const co = (b) => post(checkout, b);

  let r = await co(good); let j = await r.json();
  assert.equal(r.status, 200); assert.match(j.url, /^https:\/\/checkout\.stripe\.com\//);
  let bk = tables.bookings.at(-1);
  assert.equal(bk.total_cents, 500); assert.equal(bk.status, 'pending_payment'); assert.equal(bk.customer_email, 'ann@example.com');
  assert.equal(stripeCalls.at(-1)['line_items[0][price_data][unit_amount]'], '500');
  assert.match(stripeCalls.at(-1).success_url, /\/\?paid=CO-[A-Z0-9]{5}&k=/);
  ok('checkout saves a pending booking and sends the server-computed price to Stripe (EUR 5.00 for 1 medium, 2 h)');

  r = await co({ ...good, items: { pack: 2, med: 0, large: 1 }, pick: { date: day, time: '14:00' } });
  assert.equal(tables.bookings.at(-1).total_cents, 2 * 500 + 700); // 4 h => over-3-hour tier: 2x5 + 1x7
  ok('over 3 hours uses the higher flat price');

  r = await co({ ...good, total: 1, price: 1, items: { pack: 1, med: 0, large: 0 } });
  assert.equal(tables.bookings.at(-1).total_cents, 400); ok('a price sent by the browser is ignored');

  for (const [why, bad, code] of [
    ['overnight', { pick: { date: new Date(Date.parse(day) + 864e5).toISOString().slice(0, 10), time: '10:00' } }, 'same_day_only'],
    ['past day', { drop: { date: '2020-01-01', time: '10:00' }, pick: { date: '2020-01-01', time: '12:00' } }, 'bad_date'],
    ['pick-up before drop-off', { pick: { date: day, time: '09:00' } }, 'bad_time'],
    ['odd minutes', { drop: { date: day, time: '10:07' } }, 'bad_time'],
    ['no bags', { items: { pack: 0, med: 0, large: 0 } }, 'no_bags'],
    ['11 bags of one kind', { items: { pack: 11, med: 0, large: 0 } }, 'bad_items'],
    ['no tick box', { agree: false }, 'must_agree'],
    ['bad email', { email: 'nope' }, 'bad_email'],
    ['bad phone', { phone: '123' }, 'bad_phone'],
    ['unknown place', { partner: 'ghost' }, 'partner_unavailable'],
    ['paused place', { partner: 'paused' }, 'partner_unavailable'],
  ]) {
    const n = tables.bookings.length; r = await co({ ...good, ...bad });
    assert.equal(r.status >= 400, true, why); assert.equal((await r.json()).error, code, why); assert.equal(tables.bookings.length, n, why + ': nothing saved');
  }
  ok('11 kinds of bad input are refused and nothing is saved');

  const saved = env.STRIPE_SECRET_KEY; delete env.STRIPE_SECRET_KEY;
  const n1 = tables.bookings.length; r = await co(good); assert.equal(r.status, 503); assert.equal(tables.bookings.length, n1);
  env.STRIPE_SECRET_KEY = saved; ok('without Stripe keys: clean "not configured", no stray booking');

  // webhook
  const ref = bk.ref; const sessionId = 'cs_test_1';
  const evt = (type, over = {}) => JSON.stringify({ type, data: { object: { id: sessionId, metadata: { ref }, payment_status: 'paid', amount_total: 500, currency: 'eur', ...over } } });
  const sign = (body, t = Math.floor(Date.now() / 1000), secret = 'whsec_test') => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  const hook = (body, sig) => webhook.onRequestPost({ env, request: new Request(ORIGIN + '/api/stripe-webhook', { method: 'POST', headers: sig ? { 'stripe-signature': sig } : {}, body }) });
  let body = evt('checkout.session.completed');
  assert.equal((await hook(body)).status, 400);
  assert.equal((await hook(body, sign(body, undefined, 'whsec_wrong'))).status, 400);
  assert.equal((await hook(body, sign(body, Math.floor(Date.now() / 1000) - 3600))).status, 400);
  assert.equal(tables.bookings.find((x) => x.ref === ref).status, 'pending_payment'); ok('webhook without a valid, fresh signature is refused and changes nothing');

  body = evt('checkout.session.completed', { amount_total: 1 });
  assert.equal((await hook(body, sign(body))).status, 200); assert.equal(tables.bookings.find((x) => x.ref === ref).status, 'pending_payment'); assert.equal(outbox.length, 0);
  body = evt('checkout.session.completed', { payment_status: 'unpaid' });
  await hook(body, sign(body)); assert.equal(tables.bookings.find((x) => x.ref === ref).status, 'pending_payment');
  ok('wrong amount or unpaid session never confirms a booking');

  body = evt('checkout.session.completed');
  assert.equal((await hook(body, sign(body))).status, 200);
  assert.equal(tables.bookings.find((x) => x.ref === ref).status, 'booked'); assert.equal(outbox.length, 1);
  const mail = outbox[0]; assert.equal(mail.to[0], 'ann@example.com');
  assert.match(mail.html, /api\/qr\?ref=CO-[A-Z0-9]{5}&amp;k=/); assert.match(mail.html, /google\.com\/maps\/dir\/\?api=1&amp;destination=43\.2,27\.9/); assert.match(mail.html, /Sample address 1/);
  await hook(body, sign(body)); assert.equal(outbox.length, 1); ok('payment confirmed: booked, one email with QR, address and directions; repeat delivery sends nothing more');

  // lookup
  const bkr = tables.bookings.find((x) => x.ref === ref);
  const tok = new URL(/href="([^"]*paid=[^"]*)"/.exec(mail.html)[1].replace(/&amp;/g, '&')).searchParams.get('k');
  const look = (q) => bookingApi.onRequestGet({ env, request: new Request(ORIGIN + '/api/booking?' + q) });
  r = await look(`ref=${ref}&k=${tok}`); j = await r.json(); assert.equal(j.place.address, 'Sample address 1'); assert.equal(j.status, 'booked');
  r = await look(`ref=${ref}&email=ANN@example.com`); assert.equal(r.status, 200);
  assert.equal((await look(`ref=${ref}&email=other@example.com`)).status, 404);
  assert.equal((await look(`ref=${ref}&k=wrong`)).status, 404);
  assert.equal((await look(`ref=CO-ZZZZZ&email=ann@example.com`)).status, 404);
  assert.equal((await look(`ref=${ref}`)).status, 404);
  ok('booking lookup needs the signed link or reference + matching email');
  const pend = tables.bookings.find((x) => x.status === 'pending_payment');
  j = await (await look(`ref=${pend.ref}&email=${pend.customer_email}`)).json(); assert.equal(j.place, null); ok('address stays hidden until the booking is paid');

  // qr
  r = await qrApi.onRequestGet({ env, request: new Request(`${ORIGIN}/api/qr?ref=${ref}&k=${tok}`) });
  const png = new Uint8Array(await r.arrayBuffer());
  assert.equal(r.headers.get('content-type'), 'image/png'); assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const w = (png[16] << 24) | (png[17] << 16) | (png[18] << 8) | png[19]; assert.ok(w > 100 && w % 8 === 0);
  const idatLen = (png[33] << 24) | (png[34] << 16) | (png[35] << 8) | png[36]; assert.equal(String.fromCharCode(...png.slice(37, 41)), 'IDAT');
  const rawPx = inflateSync(Buffer.from(png.slice(41, 41 + idatLen))); assert.equal(rawPx.length, (Math.ceil(w / 8) + 1) * w);
  for (let y = 0; y < w; y++) assert.equal(rawPx[y * (Math.ceil(w / 8) + 1)], 0, 'PNG row filter byte must be 0');
  r = await qrApi.onRequestGet({ env, request: new Request(`${ORIGIN}/api/qr?ref=${ref}&k=bad`) }); assert.equal(r.status, 404);
  ok('QR image is a valid PNG; bad token gets nothing');

  // expiry
  body = evt('checkout.session.expired', { id: 'cs_test_2', metadata: { ref: pend.ref } });
  pend.stripe_session_id = 'cs_test_2';
  await hook(body, sign(body)); assert.equal(pend.status, 'cancelled'); ok('abandoned checkout is cancelled when Stripe says it expired');
}

// ---------- not configured ----------
{
  const saved = { ...env }; delete env.RESEND_API_KEY;
  const r = await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal(r.status, 503); Object.assign(env, saved); ok('missing settings give a clean "not configured" answer');
}
console.log(`\n${passed} checks passed`);

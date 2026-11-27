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
import * as pBookings from '../functions/api/partner/bookings.js';
import * as pAction from '../functions/api/partner/action.js';
import * as pPause from '../functions/api/partner/pause.js';
import * as oSummary from '../functions/api/owner/summary.js';
import * as oPayout from '../functions/api/owner/payout.js';
import * as oPartners from '../functions/api/owner/partners.js';
import * as pubPartners from '../functions/api/partners.js';
import { makeToken, cookieHeader } from '../functions/_shared/session.js';
import { createHmac } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { nowInVarna } from '../functions/_shared/pricing.js';

const ORIGIN = 'https://carryoff.eu';
const env = {
  SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', SESSION_SECRET: 'x'.repeat(40),
  RESEND_API_KEY: 're_test', OWNER_EMAIL: 'Owner@Example.com', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test',
};

// ---------- fake backends ----------
const tables = { partners: [], partner_applications: [], login_codes: [], owner_settings: [], email_log: [], bookings: [], payouts: [] };
let geoResult = [{ lat: '43.2051', lon: '27.9102' }]; const geoCalls = [];
let refundFails = false; const refunds = [];
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
  if (op === 'lt') return String(x) < val;
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(x));
  throw new Error('fake: unsupported op ' + op);
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === 'api.resend.com') {
    if (resendFails) return new Response('boom', { status: 500 });
    outbox.push(JSON.parse(init.body));
    return new Response('{"id":"1"}', { status: 200 });
  }
  if (u.host === 'nominatim.openstreetmap.org') { geoCalls.push(u.searchParams.get('q')); return new Response(JSON.stringify(geoResult)); }
  if (u.host === 'api.stripe.com' && u.pathname === '/v1/refunds') {
    if (refundFails) return new Response('{"error":{"message":"nope"}}', { status: 400 });
    refunds.push({ ...Object.fromEntries(new URLSearchParams(init.body)), key: init.headers['idempotency-key'] });
    return new Response('{"id":"re_1"}', { status: 200 });
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
  const filters = [...u.searchParams].filter(([k]) => !['select', 'order', 'limit', 'on_conflict', 'and'].includes(k));
  const ands = (u.searchParams.get('and') || '').replace(/^\(|\)$/g, '').split(',').filter(Boolean).map((x) => { const [c, o, ...v] = x.split('.'); return [c, `${o}.${v.join('.')}`]; });
  let rows = t.filter((r) => [...filters, ...ands].every(([k, v]) => matches(r, k, v)));
  if (init.method === 'GET') {
    if (u.searchParams.get('order')) { const [c, d] = u.searchParams.get('order').split('.'); rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : 1) * (d === 'desc' ? -1 : 1)); }
    if (u.searchParams.get('limit')) rows = rows.slice(0, +u.searchParams.get('limit'));
    return new Response(JSON.stringify(rows));
  }
  if (init.method === 'POST' && u.searchParams.get('on_conflict')) {
    const keys = u.searchParams.get('on_conflict').split(','), body = JSON.parse(init.body);
    const ex = t.find((r) => keys.every((k) => r[k] === body[k]));
    if (ex) { Object.assign(ex, body); return new Response(JSON.stringify([ex])); }
    t.push({ id: idc++, ...body }); return new Response(JSON.stringify([t.at(-1)]), { status: 201 });
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


// ---------- stage 3: partner check-in / hand-back / refusal, owner payouts ----------
{
  const sess = async (role, sub) => cookieHeader((await makeToken(env, role, sub)).token, 60).split(';')[0];
  const aurora = await sess('partner', 'aurora'), mosaic = await sess('partner', 'mosaic'), owner = await sess('owner', 'owner');
  const today = nowInVarna().date;
  const mk = (ref, extra = {}) => { const b = { id: idc++, ref, partner_id: 'aurora', customer_name: 'Anna Lee', customer_email: `${ref.toLowerCase()}@example.com`, customer_phone: '+359 888123456', drop_date: today, drop_time: '09:00', pick_date: today, pick_time: '15:00', n_pack: 1, n_med: 1, n_large: 0, total_cents: 1000, status: 'booked', payment_intent: 'pi_' + ref, created_at: new Date().toISOString(), ...extra }; tables.bookings.push(b); return b; };
  const get = (mod, cookie, q = '') => mod.onRequestGet({ env, request: new Request(ORIGIN + '/api/x' + q, { headers: cookie ? { cookie } : {} }) });
  const act = (cookie, body) => post(pAction, body, cookie);
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(200);
  const A = mk('CO-AAAA1'), B = mk('CO-BBBB2'), F = mk('CO-FFFF3', { drop_date: '2099-01-01', pick_date: '2099-01-01' });

  assert.equal((await get(pBookings)).status, 401);
  assert.equal((await get(pBookings, cookieOf(await post(logout, {})))).status, 401);
  let j = await (await get(pBookings, aurora)).json();
  const a1 = j.bookings.find((x) => x.ref === 'CO-AAAA1');
  assert.equal(a1.name, 'Anna'); assert.ok(!JSON.stringify(j).includes('@example.com') && !JSON.stringify(j).includes('+359'));
  assert.ok(['CO-AAAA1', 'CO-BBBB2', 'CO-FFFF3'].every((r) => j.bookings.some((x) => x.ref === r)));
  ok('partner sees only first name, bags and times; no email or phone');
  assert.equal((await get(pBookings, mosaic).then((r) => r.json())).bookings.length, 0); ok('a partner never sees another partner\'s bookings');

  assert.equal((await act(mosaic, { ref: 'CO-AAAA1', action: 'checkin', tags: ['1', '2'], photo })).status, 404); ok('another partner cannot act on the booking');
  assert.equal((await act(aurora, { ref: 'CO-AAAA1', action: 'checkin', tags: ['1'], photo })).status, 400);
  assert.equal((await act(aurora, { ref: 'CO-AAAA1', action: 'checkin', tags: ['7', '7'], photo })).status, 400);
  assert.equal((await act(aurora, { ref: 'CO-AAAA1', action: 'checkin', tags: ['7', '8'], photo: 'data:text/html;base64,AAAA' })).status, 400);
  assert.equal((await act(aurora, { ref: 'CO-FFFF3', action: 'checkin', tags: ['7', '8'], photo })).status, 409); ok('check-in needs one unique tag per bag, a JPEG photo and the booking day');
  assert.equal((await post(pAction, { ref: 'CO-AAAA1', action: 'checkin', tags: ['7', '8'], photo })).status, 401);
  outbox.length = 0;
  let r = await act(aurora, { ref: 'CO-AAAA1', action: 'checkin', tags: ['7', '8'], photo });
  assert.equal(r.status, 200); assert.equal(A.status, 'stored'); assert.deepEqual(A.tags, ['7', '8']); assert.equal(A.photo_data, photo);
  assert.match(outbox.at(-1).subject, /stored/i); assert.match(outbox.at(-1).html, /api\/qr\?ref=CO-AAAA1&amp;k=/); assert.match(outbox.at(-1).html, /show this QR code/i); assert.ok(JSON.stringify(outbox.at(-1).to).includes("co-aaaa1@example.com"));
  assert.equal((await act(aurora, { ref: 'CO-AAAA1', action: 'checkin', tags: ['7', '8'], photo })).status, 409); assert.equal(outbox.length, 1);
  ok('bags received: stored with tags and photo, customer emailed once; a second tap does nothing');
  j = await (await get(bookingApi, null, `?ref=CO-AAAA1&email=co-aaaa1@example.com`)).json();
  assert.equal(j.status, 'stored'); assert.equal(j.photo, photo); assert.deepEqual(j.tags, ['7', '8']); ok('customer sees status, tags and photo');

  r = await act(aurora, { ref: 'CO-AAAA1', action: 'return' });
  assert.equal(A.status, 'returned'); assert.equal(A.photo_data, null); assert.match(outbox.at(-1).subject, /handed back/i);
  assert.equal((await act(aurora, { ref: 'CO-AAAA1', action: 'return' })).status, 409); ok('bags handed back: status updated, photo deleted, customer thanked');

  refundFails = true; r = await act(aurora, { ref: 'CO-BBBB2', action: 'refuse' });
  assert.equal(r.status, 502); assert.equal(B.status, 'booked'); refundFails = false; ok('if the refund fails nothing changes and the partner can retry');
  outbox.length = 0; r = await act(aurora, { ref: 'CO-BBBB2', action: 'refuse' });
  assert.equal(B.status, 'refused'); assert.equal(refunds.length, 1); assert.equal(refunds[0].payment_intent, 'pi_CO-BBBB2'); assert.equal(refunds[0].key, 'refund-CO-BBBB2');
  assert.match(outbox.at(-1).subject, /could not be stored/i); assert.ok(B.refunded_at); ok('refusing bags refunds the payment in full and tells the customer');
  assert.equal((await act(aurora, { ref: 'CO-BBBB2', action: 'refuse' })).status, 409); assert.equal(refunds.length, 1); ok('a refused booking cannot be refunded twice');

  const paused = await (await post(pPause, { paused: true }, aurora)).json(); assert.equal(paused.paused, true);
  assert.equal(tables.partners.find((x) => x.id === 'aurora').paused, true); await post(pPause, { paused: false }, aurora); ok('partner can pause and reopen new bookings');
  assert.equal((await post(pPause, { paused: true })).status, 401);

  // owner
  const month = nowInVarna().date.slice(0, 7);
  const last = (() => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 15)).toISOString().slice(0, 10); })();
  mk('CO-LAST1', { drop_date: last, pick_date: last, status: 'returned', n_pack: 2, n_med: 1, total_cents: 1500 });
  mk('CO-LAST2', { drop_date: last, pick_date: last, status: 'refused', total_cents: 900 });
  assert.equal((await get(oSummary, aurora)).status, 401); assert.equal((await get(oSummary)).status, 401);
  j = await (await get(oSummary, owner)).json();
  const st = j.stats.find((x) => x.partner === 'aurora' && x.month === last.slice(0, 7));
  assert.equal(st.bags, 3); assert.equal(st.revCents, 1500); ok('owner sees bags and customer payments per partner and month; refused bookings do not count');
  assert.equal((await post(oPayout, { partner: 'aurora', month }, owner)).status, 400); ok('the running month cannot be paid out');
  assert.equal((await post(oPayout, { partner: 'aurora', month: last.slice(0, 7) }, aurora)).status, 401);
  r = await (await post(oPayout, { partner: 'aurora', month: last.slice(0, 7) }, owner)).json();
  assert.equal(r.payout.amount_cents, 150); assert.equal(r.payout.status, 'paid');
  await post(oPayout, { partner: 'aurora', month: last.slice(0, 7) }, owner); assert.equal(tables.payouts.length, 1); ok('owner marks a month as paid: 3 bags x EUR 0.50, once');
  j = await (await get(pBookings, aurora)).json(); assert.equal(j.payouts[0].status, 'paid'); ok('partner sees the month as paid');
}


// ---------- stage 4: real partners, capacity, opening hours ----------
{
  const ownerC = cookieHeader((await makeToken(env, 'owner', 'owner')).token, 60).split(';')[0];
  const get = (mod, cookie) => mod.onRequestGet({ env, request: new Request(ORIGIN + '/api/x', { headers: cookie ? { cookie } : {} }) });
  const add = (body, cookie = ownerC) => post(oPartners, body, cookie);
  const base = { area: 'city centre', name: 'Кафе Македония', type: 'Café', address: 'ул. Македония 19', contact: 'Ivan', phone: '+359 888 111222', email: 'Ivan@Example.com', cap: 3, opens: '08:00', closes: '20:00', days: [1, 2, 3, 4, 5, 6], desc: 'Test place', perks: ['Staff on site'] };

  assert.equal((await post(oPartners, base, '')).status, 401); assert.equal((await get(oPartners)).status, 401); ok('only the owner can add partners');
  assert.equal((await add({ ...base, email: 'nope' })).status, 400); assert.equal((await add({ ...base, closes: '07:00' })).status, 400);
  geoResult = []; assert.equal((await add(base)).status, 422); ok('bad details or an address that cannot be found are refused');
  assert.equal((await add({ ...base, coords: '50.1, 10.2' })).status, 422); ok('coordinates outside Varna are refused');
  { const { parseMapsPin } = await import('../functions/_shared/geocode.js');
    const eq2 = async (t, la, ln) => { const c = await parseMapsPin(t); assert.ok(c && Math.abs(c.lat - la) < 1e-6 && Math.abs(c.lng - ln) < 1e-6, t); };
    await eq2('43.2051, 27.9102', 43.2051, 27.9102);
    await eq2('Café Mosaic\nhttps://www.google.com/maps/place/Cafe/@43.2051,27.9102,17z/data=!3m1', 43.2051, 27.9102);
    await eq2('https://www.google.com/maps/place/X/data=!4m6!3d43.2111!4d27.9222', 43.2111, 27.9222);
    await eq2('https://maps.google.com/?q=43.2012,27.9033', 43.2012, 27.9033);
    assert.equal(await parseMapsPin('hello there'), null);
    ok('Google Maps pins (share links and coordinates) are read'); }
  assert.equal((await add({ ...base, name: 'Lunch A', email: 'la@example.com', bfrom: '13:00' })).status, 400); ok('lunch break needs both times');
  assert.equal((await add({ ...base, name: 'Lunch B', email: 'lb@example.com', bfrom: '14:00', bto: '13:00' })).status, 400); ok('lunch break must end after it starts');
  { const r = await add({ ...base, name: 'Lunch Shop', email: 'lunch@example.com', coords: '43.21, 27.91', bfrom: '12:30', bto: '13:30' }); assert.equal(r.status, 201);
    const row = tables.partners.find((p) => p.email === 'lunch@example.com'); assert.deepEqual(row.hours[2], ['08:00', '20:00', '12:30', '13:30']); assert.equal(row.hours[0], null); ok('lunch break is stored on every open day');
    const { openFor } = await import('../functions/_shared/capacity.js'); const tue = '2030-01-01';
    assert.equal(openFor(row.hours, tue, '12:00', '15:00'), true); assert.equal(openFor(row.hours, tue, '13:00', '15:00'), false); assert.equal(openFor(row.hours, tue, '09:00', '12:30'), false); assert.equal(openFor(row.hours, tue, '13:30', '15:00'), true);
    ok('no drop-off or pick-up during the lunch break'); }
  assert.equal((await add({ ...base, coords: 'not a pin' })).status, 422); ok('unreadable pin is refused');
  { const r = await add({ ...base, name: 'No Address Shop', email: 'noaddr@example.com', address: '', coords: 'https://www.google.com/maps/place/X/@43.2150,27.9100,17z' }); assert.equal(r.status, 201); ok('address is optional when a pin is pasted'); }
  geoResult = [{ lat: '43.2051', lon: '27.9102' }]; outbox.length = 0;
  let r = await add(base), j = await r.json(); assert.equal(r.status, 201); assert.equal(j.id, 'kafe-makedoniya');
  const row = tables.partners.find((p) => p.id === 'kafe-makedoniya');
  assert.equal(row.email, 'ivan@example.com'); assert.equal(row.lat, 43.2051); assert.deepEqual(row.hours[0], null); assert.deepEqual(row.hours[1], ['08:00', '20:00']); assert.ok(geoCalls.at(-1).includes('Varna'));
  const dist = Math.hypot((row.pub_lat - row.lat) * 111320, (row.pub_lng - row.lng) * 111320 * Math.cos(row.lat * Math.PI / 180)); assert.ok(dist > 30 && dist < 100, 'pin offset ' + dist);
  assert.match(outbox.at(-1).subject, /Welcome/); assert.ok(JSON.stringify(outbox.at(-1).to).includes('ivan@example.com')); ok('owner adds a partner: located, public pin offset, hours saved, welcome email sent');
  assert.equal((await add(base)).status, 409); ok('the same email cannot be used for two partners');
  r = await add({ ...base, name: 'Кафе Македония', email: 'second@example.com', coords: '43.2100, 27.9200' }); j = await r.json(); assert.equal(j.id, 'kafe-makedoniya-2'); ok('same name gets its own id; pasted coordinates are used');
  j = await (await get(oPartners, ownerC)).json(); assert.ok(j.partners.some((p) => p.id === 'kafe-makedoniya')); assert.ok(!('applications' in j) || Array.isArray(j.applications));

  // public list
  j = await (await get(pubPartners)).json();
  const pub = j.places.find((p) => p.id === 'kafe-makedoniya');
  assert.ok(pub && pub.lat === row.pub_lat); assert.equal(pub.area, 'city centre'); assert.ok(!JSON.stringify(j).includes('Кафе') && !JSON.stringify(j).includes('ivan@example.com') && !JSON.stringify(j).includes('Македония 19') && !JSON.stringify(j).includes(String(row.lat)));
  ok('public list has approximate pins only: no address, email or exact position');
  await add({ action: 'set_active', id: 'kafe-makedoniya-2', active: false });
  j = await (await get(pubPartners)).json(); assert.ok(!j.places.some((p) => p.id === 'kafe-makedoniya-2')); ok('a switched-off partner disappears from the public list');

  // capacity and opening hours at checkout
  const friday = (() => { let d = new Date(Date.now() + 3 * 864e5); while (d.getUTCDay() !== 5) d = new Date(+d + 864e5); return d.toISOString().slice(0, 10); })();
  const sunday = (() => { let d = new Date(Date.now() + 3 * 864e5); while (d.getUTCDay() !== 0) d = new Date(+d + 864e5); return d.toISOString().slice(0, 10); })();
  const co = (extra) => post(checkout, { partner: 'kafe-makedoniya', name: 'Cap Test', email: 'cap@example.com', phone: '+359 888123456', agree: true, items: { pack: 1 }, drop: { date: friday, time: '10:00' }, pick: { date: friday, time: '12:00' }, ...extra });
  assert.equal((await co({ drop: { date: friday, time: '07:00' } })).status, 409); ok('checkout refuses a drop-off before opening');
  assert.equal((await co({ pick: { date: friday, time: '19:45' } })).status, 409); ok('checkout refuses pick-up in the last 30 minutes before closing');
  assert.equal((await co({ drop: { date: sunday, time: '10:00' }, pick: { date: sunday, time: '12:00' } })).status, 409); ok('checkout refuses a closed day');
  assert.equal((await co({ items: { pack: 4 } })).status, 409); ok('checkout refuses more bags than the place can hold');
  assert.equal((await co({ items: { pack: 2 }, email: 'cap1@example.com' })).status, 200);
  assert.equal((await co({ items: { pack: 2 }, email: 'cap2@example.com' })).status, 409); ok('bags already booked count against capacity');
  assert.equal((await co({ items: { pack: 1 }, email: 'cap3@example.com' })).status, 200); ok('the last free space can still be booked');
  j = await (await get(pubPartners)).json(); assert.equal(j.booked[`kafe-makedoniya|${friday}`], 3); ok('public list shows how many bags are booked per day');
}

// ---------- not configured ----------
{
  const saved = { ...env }; delete env.RESEND_API_KEY;
  const r = await post(partnerSend, { email: 'mosaic@example.com' });
  assert.equal(r.status, 503); Object.assign(env, saved); ok('missing settings give a clean "not configured" answer');
}
console.log(`\n${passed} checks passed`);

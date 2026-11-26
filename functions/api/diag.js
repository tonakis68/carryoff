// TEMPORARY diagnostic: tests each step of starting a payment on its own. Remove after debugging. Shows no secrets.
import { db, eq } from '../_shared/db.js';
import { bookToken } from '../_shared/booktoken.js';
import { json } from '../_shared/util.js';

export async function onRequestGet({ env }) {
  const out = {};
  const step = async (name, fn) => {
    const t = Date.now();
    try { out[name] = { ok: true, ms: 0, ...(await fn()) }; } catch (e) { out[name] = { ok: false, error: String((e && e.message) || e).slice(0, 160) }; }
    out[name].ms = Date.now() - t;
  };
  const key = env.STRIPE_SECRET_KEY || '';
  out.key = { prefix: key.slice(0, 8), length: key.length, hasSpace: /\s/.test(key) };
  await step('token', async () => ({ len: (await bookToken(env, 'CO-test')).length }));
  await step('db', async () => ({ rows: (await db.select(env, 'partners', { limit: 1, select: 'id' })).length }));
  await step('stripe_get', async () => {
    const r = await fetch('https://api.stripe.com/v1/balance', { headers: { authorization: `Bearer ${key}` } });
    return { status: r.status };
  });
  await step('stripe_post', async () => {
    const p = new URLSearchParams({ mode: 'payment', success_url: 'https://carryoff.eu/?ok=1', cancel_url: 'https://carryoff.eu/', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': '500', 'line_items[0][price_data][product_data][name]': 'diag' });
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: p.toString() });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, hasUrl: !!j.url, message: j.error && String(j.error.message).replace(/(sk|rk|pk)_\w+/g, '[key]').slice(0, 120) };
  });
  return json(out);
}

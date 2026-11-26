// Stripe over plain fetch (no library). Test or live mode is decided by the key you set.
import { hmacBytes, toHex, timingEq, HttpError } from './util.js';

export async function createCheckout(env, { ref, email, cents, name, successUrl, cancelUrl, description }) {
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', successUrl);
  p.set('cancel_url', cancelUrl);
  p.set('client_reference_id', ref);
  p.set('customer_email', email);
  p.set('metadata[ref]', ref);
  p.set('payment_intent_data[metadata][ref]', ref);
  p.set('payment_intent_data[description]', description);
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', 'eur');
  p.set('line_items[0][price_data][unit_amount]', String(cents));
  p.set('line_items[0][price_data][product_data][name]', name);
  p.set('expires_at', String(Math.floor(Date.now() / 1000) + 31 * 60)); // Stripe minimum is 30 minutes
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.url) {
    console.error('stripe checkout', res.status, JSON.stringify(j).slice(0, 300));
    throw new HttpError(502, 'payment_error');
  }
  return { id: j.id, url: j.url };
}

// Verify the "Stripe-Signature" header: HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret.
export async function verifyWebhook(env, rawBody, header, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = header.split(',').map((s) => s.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const expected = toHex(await hmacBytes(env.STRIPE_WEBHOOK_SECRET, `${t}.${rawBody}`));
  return sigs.some((s) => timingEq(s, expected));
}

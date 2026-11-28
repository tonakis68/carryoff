import { db, eq } from '../../_shared/db.js';
import { sendMail, tpl } from '../../_shared/mail.js';
import { lateFee } from '../../_shared/pricing.js';
import { requireRole } from '../../_shared/session.js';
import { createCheckout, expireCheckout } from '../../_shared/stripe.js';
import { HttpError, handler, json, needEnv, readJson, requireSameOrigin } from '../../_shared/util.js';

// Owner only. GET: list of late fees. POST {ref}: preview (default) or {ref, send:true}: create the payment link and email it.
export const onRequestGet = handler(async ({ request, env }) => {
  await requireRole(env, request, 'owner');
  const fees = await db.select(env, 'late_fees', { order: 'created_at.desc', limit: 50 }).catch(() => []);
  return json({ ok: true, fees });
});

export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'STRIPE_SECRET_KEY']);
  await requireRole(env, request, 'owner');
  const b = await readJson(request, 2000);
  const ref = String(b.ref || '').trim().toUpperCase();
  if (!/^CO-[A-Z0-9]{5}$/.test(ref)) throw new HttpError(400, 'bad_ref');
  const bk = (await db.select(env, 'bookings', { filters: { ref: eq(ref) }, limit: 1 }))[0];
  if (!bk) throw new HttpError(404, 'not_found');
  if (bk.status !== 'stored' && bk.status !== 'returned') throw new HttpError(409, 'wrong_status'); // the bags must have been received
  const fee = lateFee(bk.total_cents);
  const prev = (await db.select(env, 'late_fees', { filters: { ref: eq(ref) }, limit: 1 }))[0];
  if (prev && prev.status === 'paid') throw new HttpError(409, 'already_paid');
  const info = { ref, name: bk.customer_name, email: bk.customer_email, feeCents: fee.cents, partnerCents: fee.partnerCents, resend: !!prev };
  if (!b.send) return json({ ok: true, preview: info });

  const origin = new URL(request.url).origin;
  const session = await createCheckout(env, {
    ref, email: bk.customer_email, cents: fee.cents,
    name: `Late collection fee · booking ${ref}`, description: `CarryOff late collection fee ${ref}`,
    successUrl: `${origin}/?latefee=paid`, cancelUrl: `${origin}/`,
    meta: { kind: 'late_fee' }, expiresMin: 23 * 60,
  });
  const row = { ref, partner_id: bk.partner_id, month: bk.drop_date.slice(0, 7), fee_cents: fee.cents, partner_cents: fee.partnerCents, status: 'sent', stripe_session_id: session.id };
  if (prev) { await db.update(env, 'late_fees', { ref: eq(ref) }, row); if (prev.stripe_session_id) await expireCheckout(env, prev.stripe_session_id); }
  else await db.insert(env, 'late_fees', row);
  await sendMail(env, { to: bk.customer_email, ...tpl.lateFeeRequest({ ref, name: bk.customer_name, fee: (fee.cents / 100).toFixed(2), url: session.url }) });
  return json({ ok: true, sent: info, url: session.url });
});

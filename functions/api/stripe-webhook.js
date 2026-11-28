import { bookToken } from '../_shared/booktoken.js';
import { db, eq } from '../_shared/db.js';
import { sendMail, tpl } from '../_shared/mail.js';
import { nowInVarna } from '../_shared/pricing.js';
import { verifyWebhook } from '../_shared/stripe.js';
import { handler, json } from '../_shared/util.js';

// Stripe tells us here that a payment went through. This is the ONLY place a booking becomes "booked".
export const onRequestPost = handler(async ({ request, env }) => {
  const raw = await request.text();
  if (!(await verifyWebhook(env, raw, request.headers.get('stripe-signature')))) return json({ ok: false, error: 'bad_signature' }, 400);
  const ev = JSON.parse(raw);
  const s = ev?.data?.object;
  const ref = s?.metadata?.ref || s?.client_reference_id;
  if (!ref || !String(s?.id || '').startsWith('cs_')) return json({ ok: true, ignored: true });

  if (s?.metadata?.kind === 'late_fee') return lateFeePaid(env, ev, s, ref);

  const booking = (await db.select(env, 'bookings', { filters: { ref: eq(ref) }, limit: 1 }))[0];
  if (!booking || booking.stripe_session_id !== s.id) return json({ ok: true, ignored: true });

  if (ev.type === 'checkout.session.expired') {
    await db.update(env, 'bookings', { ref: eq(ref), status: eq('pending_payment') }, { status: 'cancelled' });
    return json({ ok: true });
  }
  if (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded') return json({ ok: true, ignored: true });
  if (s.payment_status !== 'paid') return json({ ok: true, waiting: true });
  if (s.amount_total !== booking.total_cents || s.currency !== 'eur') {
    console.error('amount mismatch', ref, s.amount_total, booking.total_cents);
    return json({ ok: true, ignored: true });
  }

  // Only the first delivery flips the status, so a repeated webhook never sends a second email.
  const flipped = await db.update(env, 'bookings', { ref: eq(ref), status: eq('pending_payment') }, { status: 'booked', paid_at: new Date().toISOString(), ...(typeof s.payment_intent === 'string' ? { payment_intent: s.payment_intent } : {}) });
  if (flipped.length) {
    const partner = (await db.select(env, 'partners', { filters: { id: eq(booking.partner_id) }, limit: 1 }))[0] || {};
    const origin = new URL(request.url).origin;
    const k = await bookToken(env, ref);
    await sendMail(env, { to: booking.customer_email, ...tpl.bookingConfirmed({
      ref, name: booking.customer_name, place: partner.name || '', address: partner.address || '', lat: partner.lat, lng: partner.lng,
      date: booking.drop_date, dropTime: booking.drop_time, pickTime: booking.pick_time,
      bags: booking.n_pack + booking.n_med + booking.n_large, total: (booking.total_cents / 100).toFixed(2),
      qrUrl: `${origin}/api/qr?ref=${ref}&k=${k}`, bookingUrl: `${origin}/?paid=${ref}&k=${k}`,
    }) });
  }
  return json({ ok: true });
});

// A late collection fee was paid through the payment link the owner sent.
async function lateFeePaid(env, ev, s, ref) {
  if (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded') return json({ ok: true, ignored: true });
  if (s.payment_status !== 'paid') return json({ ok: true, waiting: true });
  const fee = (await db.select(env, 'late_fees', { filters: { ref: eq(ref) }, limit: 1 }))[0];
  if (!fee || s.amount_total !== fee.fee_cents || s.currency !== 'eur') { console.error('late fee mismatch', ref, s.amount_total); return json({ ok: true, ignored: true }); }
  const flipped = await db.update(env, 'late_fees', { ref: eq(ref), status: eq('sent') }, { status: 'paid', paid_at: new Date().toISOString() });
  if (flipped.length) {
    const bk = (await db.select(env, 'bookings', { filters: { ref: eq(ref) }, limit: 1 }))[0] || {};
    if (bk.customer_email) await sendMail(env, { to: bk.customer_email, ...tpl.lateFeePaid({ ref, name: bk.customer_name, fee: (fee.fee_cents / 100).toFixed(2) }) });
    if (fee.month < nowInVarna().date.slice(0, 7) && env.OWNER_EMAIL) { // its month is over: the partner's half is due now
      const pn = (await db.select(env, 'partners', { filters: { id: eq(fee.partner_id) }, select: 'name', limit: 1 }))[0];
      await sendMail(env, { to: env.OWNER_EMAIL, ...tpl.lateFeeDue({ ref, partner: pn?.name || fee.partner_id, amount: (fee.partner_cents / 100).toFixed(2) }) });
    }
  } else console.error('late fee paid again or out of order', ref, s.id);
  return json({ ok: true });
}

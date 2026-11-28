import { bookToken } from '../_shared/booktoken.js';
import { db, eq } from '../_shared/db.js';
import { sendMail, tpl } from '../_shared/mail.js';
import { canCancelFree } from '../_shared/pricing.js';
import { refundPayment } from '../_shared/stripe.js';
import { HttpError, handler, json, needEnv, readJson, requireSameOrigin, timingEq } from '../_shared/util.js';

// A customer cancels their own booking. Allowed until the drop-off time; the payment is refunded in full.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STRIPE_SECRET_KEY']);
  const b = await readJson(request, 2000);
  const ref = String(b.ref || '').toUpperCase();
  if (!/^CO-[A-Z0-9]{5}$/.test(ref)) throw new HttpError(400, 'bad_ref');
  const bk = (await db.select(env, 'bookings', { filters: { ref: eq(ref) }, limit: 1 }))[0];
  const tok = await bookToken(env, ref);
  if (!bk || !b.k || !timingEq(String(b.k), tok)) throw new HttpError(404, 'not_found');
  if (bk.status !== 'booked') throw new HttpError(409, 'wrong_status'); // already stored, returned, refused or cancelled
  if (!bk.payment_intent) throw new HttpError(409, 'no_payment'); // paid before stage 3: handle by hand
  if (!canCancelFree(bk.drop_date, bk.drop_time)) throw new HttpError(409, 'too_late');
  // Refund first: if Stripe fails nothing changes and the customer can tap again.
  await refundPayment(env, { paymentIntent: bk.payment_intent, ref });
  const done = await db.update(env, 'bookings', { ref: eq(ref), status: eq('booked') }, { status: 'cancelled', refunded_at: new Date().toISOString() });
  if (done.length) await sendMail(env, { to: bk.customer_email, ...tpl.bookingCancelled({ ref, name: bk.customer_name }) });
  return json({ ok: true, status: 'cancelled', refunded: true });
});

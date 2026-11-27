import { db, eq } from '../../_shared/db.js';
import { sendMail, tpl } from '../../_shared/mail.js';
import { nowInVarna } from '../../_shared/pricing.js';
import { requireRole } from '../../_shared/session.js';
import { refundPayment } from '../../_shared/stripe.js';
import { HttpError, handler, json, needEnv, readJson, requireSameOrigin } from '../../_shared/util.js';

// A partner changes one booking: bags received, bags handed back, or bags refused (with automatic refund).
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']);
  const s = await requireRole(env, request, 'partner');
  const b = await readJson(request, 400000);
  const ref = String(b.ref || '').toUpperCase();
  if (!/^CO-[A-Z0-9]{5}$/.test(ref)) throw new HttpError(400, 'bad_ref');
  const bk = (await db.select(env, 'bookings', { filters: { ref: eq(ref), partner_id: eq(s.sub) }, limit: 1 }))[0];
  if (!bk) throw new HttpError(404, 'not_found'); // also when it belongs to another partner
  const partner = (await db.select(env, 'partners', { filters: { id: eq(s.sub) }, limit: 1 }))[0] || {};
  const bags = bk.n_pack + bk.n_med + bk.n_large;
  const where = (status) => ({ ref: eq(ref), partner_id: eq(s.sub), status: eq(status) }); // the status filter makes a double tap harmless

  if (b.action === 'checkin') {
    if (bk.status !== 'booked') throw new HttpError(409, 'wrong_status');
    if (bk.drop_date > nowInVarna().date) throw new HttpError(409, 'not_today');
    const tags = Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()) : [];
    if (tags.length !== bags || tags.some((t) => !t || t.length > 20) || new Set(tags).size !== tags.length) throw new HttpError(400, 'bad_tags');
    const photo = String(b.photo || '');
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 300000) throw new HttpError(400, 'bad_photo');
    const done = await db.update(env, 'bookings', where('booked'), { status: 'stored', tags, photo_data: photo, stored_at: new Date().toISOString() });
    if (done.length) await sendMail(env, { to: bk.customer_email, ...tpl.bagsReceived({ place: partner.name || '', bags, tags: tags.join(', '), lastPickup: `${bk.pick_date} ${bk.pick_time}` }) });
    return json({ ok: true, status: 'stored', at: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()) });
  }

  if (b.action === 'return') {
    if (bk.status !== 'stored') throw new HttpError(409, 'wrong_status');
    const done = await db.update(env, 'bookings', where('stored'), { status: 'returned', returned_at: new Date().toISOString(), photo_data: null });
    if (done.length) await sendMail(env, { to: bk.customer_email, ...tpl.bagsReturned() });
    return json({ ok: true, status: 'returned' });
  }

  if (b.action === 'refuse') {
    if (bk.status !== 'booked' && bk.status !== 'stored') throw new HttpError(409, 'wrong_status');
    needEnv(env, ['STRIPE_SECRET_KEY']);
    // Refund first: if Stripe fails, nothing changes and the partner can tap again.
    if (bk.payment_intent) await refundPayment(env, { paymentIntent: bk.payment_intent, ref });
    else console.error('refuse without payment_intent', ref); // booking paid before stage 3: refund it by hand in Stripe
    const done = await db.update(env, 'bookings', { ref: eq(ref), partner_id: eq(s.sub), status: `in.(booked,stored)` }, { status: 'refused', refunded_at: bk.payment_intent ? new Date().toISOString() : null, photo_data: null });
    if (done.length) await sendMail(env, { to: bk.customer_email, ...tpl.bagsRefused() });
    return json({ ok: true, status: 'refused', refunded: !!bk.payment_intent });
  }
  throw new HttpError(400, 'bad_action');
});

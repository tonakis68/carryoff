import { bookToken } from '../_shared/booktoken.js';
import { db, eq } from '../_shared/db.js';
import { cancelDeadline, canCancelFree } from '../_shared/pricing.js';
import { HttpError, handler, json, normEmail, timingEq } from '../_shared/util.js';

// Look up one booking, either with the signed link token (k) or with reference + email.
// The partner's address and map position are only returned once the booking is paid.
export const onRequestGet = handler(async ({ request, env }) => {
  const u = new URL(request.url);
  const ref = String(u.searchParams.get('ref') || '').toUpperCase();
  if (!/^CO-[A-Z0-9]{5}$/.test(ref)) throw new HttpError(400, 'bad_ref');
  const b = (await db.select(env, 'bookings', { filters: { ref: eq(ref) }, limit: 1 }))[0];
  const k = u.searchParams.get('k'), email = normEmail(u.searchParams.get('email'));
  const tok = await bookToken(env, ref);
  const okK = !!k && timingEq(k, tok);
  const okE = email && b && timingEq(email, b.customer_email);
  if (!b || !(okK || okE)) throw new HttpError(404, 'not_found'); // same answer whether the code exists or not
  const refunded = b.status === 'cancelled' && !!b.refunded_at; // cancelled by the customer after paying
  const paid = b.status !== 'pending_payment' && (b.status !== 'cancelled' || refunded);
  const p = (await db.select(env, 'partners', { filters: { id: eq(b.partner_id) }, limit: 1 }))[0] || {};
  return json({
    ok: true, ref: b.ref, status: b.status, bstatus: b.status, // bstatus: the browser helper overwrites 'status' with the HTTP code
    partner: b.partner_id, name: b.customer_name, phone: b.customer_phone,
    date: b.drop_date, dropTime: b.drop_time, pickTime: b.pick_time,
    items: { pack: b.n_pack, med: b.n_med, large: b.n_large }, totalCents: b.total_cents, tags: b.tags || [],
    refunded, canCancel: b.status === 'booked' && !!b.payment_intent && canCancelFree(b.drop_date, b.drop_time), cancelBy: cancelDeadline(b.drop_date, b.drop_time),
    k: tok, storedAt: b.stored_at, photo: b.status === 'stored' ? b.photo_data : null,
    place: paid ? { name: p.name, address: p.address, lat: p.lat, lng: p.lng } : null,
  });
});

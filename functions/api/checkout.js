import { db, eq } from '../_shared/db.js';
import { bookToken } from '../_shared/booktoken.js';
import { LONG_AFTER_MIN, minOf, nowInVarna, priceCents, validDate, validTime } from '../_shared/pricing.js';
import { createCheckout } from '../_shared/stripe.js';
import { HttpError, handler, isEmail, json, needEnv, normEmail, randRef, readJson, requireSameOrigin } from '../_shared/util.js';

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Start a payment: check everything, save the booking as "pending_payment", return the Stripe page address.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'STRIPE_SECRET_KEY']);
  const b = await readJson(request);

  const name = String(b.name || '').trim();
  const email = normEmail(b.email);
  const phone = String(b.phone || '').trim();
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'bad_name');
  if (!isEmail(email)) throw new HttpError(400, 'bad_email');
  if (!/^\+\d{1,3} \d{6,12}$/.test(phone)) throw new HttpError(400, 'bad_phone');
  if (b.agree !== true) throw new HttpError(400, 'must_agree');

  const it = b.items || {};
  const items = { pack: it.pack ?? 0, med: it.med ?? 0, large: it.large ?? 0 };
  if (!Object.values(items).every((n) => intIn(n, 0, 10))) throw new HttpError(400, 'bad_items');
  const bags = items.pack + items.med + items.large;
  if (bags < 1) throw new HttpError(400, 'no_bags');

  const drop = b.drop || {}, pick = b.pick || {};
  if (![drop.time, pick.time].every(validTime) || ![drop.date, pick.date].every(validDate)) throw new HttpError(400, 'bad_time');
  if (drop.date !== pick.date) throw new HttpError(400, 'same_day_only');
  const dur = minOf(pick.time) - minOf(drop.time);
  if (dur < 30) throw new HttpError(400, 'bad_time');
  const today = nowInVarna();
  const lastDay = new Date(Date.parse(today.date + 'T00:00:00Z') + 60 * 864e5).toISOString().slice(0, 10);
  if (drop.date < today.date || drop.date > lastDay) throw new HttpError(400, 'bad_date');
  if (drop.date === today.date && minOf(drop.time) < today.minutes - 15) throw new HttpError(400, 'in_the_past');

  const partner = (await db.select(env, 'partners', { filters: { id: eq(String(b.partner || '')), active: eq('true') }, limit: 1 }))[0];
  if (!partner || partner.paused) throw new HttpError(409, 'partner_unavailable');

  // Slow down abuse: at most 6 unpaid bookings per email per hour.
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const recent = await db.select(env, 'bookings', {
    filters: { customer_email: eq(email), status: eq('pending_payment'), created_at: `gte.${hourAgo}` }, select: 'id',
  });
  if (recent.length >= 6) throw new HttpError(429, 'rate_limited');

  const total = priceCents(items, dur);
  const origin = new URL(request.url).origin;
  let ref, row;
  for (let i = 0; i < 3 && !row; i++) {
    ref = randRef('CO-', 5);
    try {
      [row] = await db.insert(env, 'bookings', {
        ref, partner_id: partner.id, customer_name: name, customer_email: email, customer_phone: phone,
        drop_date: drop.date, drop_time: drop.time, pick_date: pick.date, pick_time: pick.time,
        n_pack: items.pack, n_med: items.med, n_large: items.large, total_cents: total, status: 'pending_payment',
      });
    } catch (e) { if (i === 2) throw e; }
  }
  const k = await bookToken(env, ref);
  const session = await createCheckout(env, {
    ref, email, cents: total,
    name: `Luggage storage in Varna · ${bags} ${bags === 1 ? 'bag' : 'bags'} · ${drop.date}`,
    description: `CarryOff booking ${ref}`,
    successUrl: `${origin}/?paid=${ref}&k=${k}`,
    cancelUrl: `${origin}/?cancelled=${ref}`,
  });
  await db.update(env, 'bookings', { ref: eq(ref) }, { stripe_session_id: session.id });
  return json({ ok: true, url: session.url, ref, long: dur > LONG_AFTER_MIN });
});

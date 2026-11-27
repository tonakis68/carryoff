import { db, eq } from '../../_shared/db.js';
import { nowInVarna } from '../../_shared/pricing.js';
import { requireRole } from '../../_shared/session.js';
import { handler, json } from '../../_shared/util.js';

const hhmm = (iso) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '');

// Everything the partner dashboard needs. Partners see first name, bags and times only: no email, phone or card data.
export const onRequestGet = handler(async ({ request, env }) => {
  const s = await requireRole(env, request, 'partner');
  const p = (await db.select(env, 'partners', { filters: { id: eq(s.sub), active: eq('true') }, limit: 1 }))[0];
  if (!p) return json({ ok: false, error: 'not_logged_in' }, 401);
  const today = nowInVarna().date;
  const [y, m] = today.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1 - 3, 1)).toISOString().slice(0, 10); // this month and the 3 before
  const rows = await db.select(env, 'bookings', {
    filters: { partner_id: eq(p.id), status: 'in.(booked,stored,returned,refused)', drop_date: `gte.${from}` },
    select: 'ref,customer_name,drop_date,drop_time,pick_date,pick_time,n_pack,n_med,n_large,status,tags,stored_at,total_cents',
    order: 'drop_date.asc,drop_time.asc', limit: 1000,
  });
  const photos = Object.fromEntries((await db.select(env, 'bookings', {
    filters: { partner_id: eq(p.id), status: eq('stored') }, select: 'ref,photo_data', limit: 200,
  })).map((r) => [r.ref, r.photo_data]));
  const payouts = await db.select(env, 'payouts', { filters: { partner_id: eq(p.id) }, select: 'month,status,bags,amount_cents' });
  return json({
    ok: true, today, partner: { id: p.id, name: p.name, paused: !!p.paused },
    bookings: rows.map((b) => ({
      ref: b.ref, name: String(b.customer_name).trim().split(/\s+/)[0], cnt: { pack: b.n_pack, med: b.n_med, large: b.n_large },
      n: b.n_pack + b.n_med + b.n_large, dDate: b.drop_date, dTime: b.drop_time, pDate: b.pick_date, pTime: b.pick_time,
      status: b.status, tags: b.tags || [], at: hhmm(b.stored_at), photo: photos[b.ref] || '', totalCents: b.total_cents,
    })),
    payouts,
  });
});

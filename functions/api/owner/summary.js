import { db } from '../../_shared/db.js';
import { nowInVarna } from '../../_shared/pricing.js';
import { requireRole } from '../../_shared/session.js';
import { handler, json } from '../../_shared/util.js';

export const PAYOUT_CENTS = 50; // per bag stored, whatever the size or length of stay

// Owner only: per partner and month, bags received, customer payments and payout state.
export const onRequestGet = handler(async ({ request, env }) => {
  await requireRole(env, request, 'owner');
  const today = nowInVarna().date;
  const [y, m] = today.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1 - 3, 1)).toISOString().slice(0, 10);
  const rows = await db.select(env, 'bookings', {
    filters: { status: 'in.(booked,stored,returned,refused)', drop_date: `gte.${from}` },
    select: 'partner_id,drop_date,n_pack,n_med,n_large,total_cents,status', limit: 5000,
  });
  const stats = {}; // "partner|month" -> totals
  for (const b of rows) {
    const k = `${b.partner_id}|${b.drop_date.slice(0, 7)}`;
    const t = (stats[k] ||= { partner: b.partner_id, month: b.drop_date.slice(0, 7), bags: 0, pending: 0, revCents: 0, bookings: 0 });
    const n = b.n_pack + b.n_med + b.n_large;
    if (b.status === 'stored' || b.status === 'returned') { t.bags += n; t.revCents += b.total_cents; t.bookings += 1; } else if (b.status === 'booked') t.pending += n;
  }
  const payouts = await db.select(env, 'payouts', { select: 'partner_id,month,status,bags,amount_cents,paid_at' });
  return json({ ok: true, today, payCents: PAYOUT_CENTS, stats: Object.values(stats), payouts });
});

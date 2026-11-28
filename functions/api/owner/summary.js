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
  const q = (select) => db.select(env, 'bookings', { filters: { status: 'in.(booked,stored,returned,refused)', drop_date: `gte.${from}` }, select, limit: 5000 });
  const cols = 'partner_id,drop_date,n_pack,n_med,n_large,total_cents,status';
  let rows;
  try { rows = await q(cols + ',source'); } catch { rows = await q(cols); } // the source column may not exist yet
  const sources = {}, others = {}; // month -> answer -> bookings; month -> typed "Other" answers
  for (const b of rows) {
    if (b.status === 'refused') continue;
    const mo = b.drop_date.slice(0, 7), m = (sources[mo] ||= {});
    let a = b.source || 'none';
    if (a.startsWith('other:')) { (others[mo] ||= []).push(a.slice(6).trim()); a = 'other'; }
    m[a] = (m[a] || 0) + 1;
  }
  const stats = {}; // "partner|month" -> totals
  for (const b of rows) {
    const k = `${b.partner_id}|${b.drop_date.slice(0, 7)}`;
    const t = (stats[k] ||= { partner: b.partner_id, month: b.drop_date.slice(0, 7), bags: 0, pending: 0, revCents: 0, bookings: 0 });
    const n = b.n_pack + b.n_med + b.n_large;
    if (b.status === 'stored' || b.status === 'returned') { t.bags += n; t.revCents += b.total_cents; t.bookings += 1; } else if (b.status === 'booked') t.pending += n;
  }
  const payouts = await db.select(env, 'payouts', { select: 'partner_id,month,status,bags,amount_cents,paid_at' });
  return json({ ok: true, today, payCents: PAYOUT_CENTS, stats: Object.values(stats), payouts, sources, others });
});

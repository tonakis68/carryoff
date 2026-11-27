import { db, eq } from '../../_shared/db.js';
import { nowInVarna } from '../../_shared/pricing.js';
import { requireRole } from '../../_shared/session.js';
import { HttpError, handler, json, needEnv, readJson, requireSameOrigin } from '../../_shared/util.js';

// Owner marks a finished month as paid to a partner (after sending the bank transfer by hand).
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']);
  await requireRole(env, request, 'owner');
  const b = await readJson(request);
  const partner = String(b.partner || ''), month = String(b.month || '');
  if (!/^\d{4}-\d{2}$/.test(month) || month >= nowInVarna().date.slice(0, 7)) throw new HttpError(400, 'bad_month'); // only finished months
  if (!(await db.select(env, 'partners', { filters: { id: eq(partner) }, select: 'id', limit: 1 })).length) throw new HttpError(404, 'not_found');
  const [y, m] = month.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const rows = await db.select(env, 'bookings', {
    filters: { partner_id: eq(partner), status: 'in.(stored,returned)', drop_date: `gte.${month}-01`, and: `(drop_date.lt.${next})` },
    select: 'n_pack,n_med,n_large', limit: 5000,
  });
  const bags = rows.reduce((a, r) => a + r.n_pack + r.n_med + r.n_large, 0);
  const row = await db.upsert(env, 'payouts', { partner_id: partner, month, bags, amount_cents: bags * 50, status: 'paid', paid_at: new Date().toISOString() }, 'partner_id,month');
  return json({ ok: true, payout: row[0] });
});

import { db } from './db.js';

// Bags already spoken for, per partner and day: paid, stored, or an unpaid checkout still open (31 minutes).
// Returns { 'partnerId|YYYY-MM-DD': bags }.
export async function bookedBags(env, { from, partnerId } = {}) {
  const fresh = new Date(Date.now() - 32 * 60e3).toISOString();
  const base = { drop_date: `gte.${from}` };
  if (partnerId) base.partner_id = `eq.${partnerId}`;
  const cols = 'partner_id,drop_date,n_pack,n_med,n_large';
  const rows = [
    ...(await db.select(env, 'bookings', { filters: { ...base, status: 'in.(booked,stored)' }, select: cols, limit: 5000 })),
    ...(await db.select(env, 'bookings', { filters: { ...base, status: 'eq.pending_payment', created_at: `gte.${fresh}` }, select: cols, limit: 5000 })),
  ];
  const out = {};
  for (const r of rows) {
    const k = `${r.partner_id}|${r.drop_date}`;
    out[k] = (out[k] || 0) + r.n_pack + r.n_med + r.n_large;
  }
  return out;
}

const minOf = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
export const LAST_PICKUP_MARGIN = 30; // pick-up at least 30 minutes before closing

// Is the place open for this drop-off and pick-up? hours: 7 entries, Sunday first, [open, close] or null.
export function openFor(hours, date, dropTime, pickTime) {
  if (!Array.isArray(hours) || hours.length !== 7) return true; // no hours stored yet: do not block
  const h = hours[new Date(date + 'T12:00:00Z').getUTCDay()];
  if (!h) return false;
  const allDay = h[0] === '00:00' && h[1] === '24:00';
  const margin = allDay ? 0 : LAST_PICKUP_MARGIN;
  return minOf(dropTime) >= minOf(h[0]) && minOf(dropTime) <= minOf(h[1]) - margin && minOf(pickTime) >= minOf(h[0]) && minOf(pickTime) <= minOf(h[1]) - margin;
}

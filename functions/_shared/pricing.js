// Prices and booking rules. The server is the only place that decides what a booking costs.
// Flat price per bag: one price for stays up to 3 hours, a higher one for longer stays. Same-day only.
export const RATES = { pack: [3.99, 4.99], med: [4.99, 5.99], large: [5.99, 6.99] }; // [up to 3 h, over 3 h], euro
export const LONG_AFTER_MIN = 180;

export const minOf = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const validTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):(00|15|30|45)$/.test(t);
export const validDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

// Today's date and time in Varna, so "today" means Bulgarian today wherever the server runs.
export function nowInVarna(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function priceCents(items, durMin) {
  const idx = durMin > LONG_AFTER_MIN ? 1 : 0;
  let total = 0;
  for (const k of Object.keys(RATES)) total += items[k] * Math.round(RATES[k][idx] * 100);
  return total;
}

// Free cancellation closes this many minutes before the drop-off time (2 hours).
export const CANCEL_MIN = 120;
const dayN = (d) => Math.floor(Date.parse(d + 'T00:00:00Z') / 864e5);
export function canCancelFree(dropDate, dropTime, now = nowInVarna()) {
  return (dayN(dropDate) - dayN(now.date)) * 1440 + minOf(dropTime) - now.minutes >= CANCEL_MIN;
}
// The last date and time (Varna) at which a customer can still cancel for a full refund.
export function cancelDeadline(dropDate, dropTime) {
  const t = dayN(dropDate) * 1440 + minOf(dropTime) - CANCEL_MIN, m = ((t % 1440) + 1440) % 1440;
  return { date: new Date(Math.floor(t / 1440) * 864e5).toISOString().slice(0, 10), time: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` };
}

// Late collection: the customer pays 3 times the booking price; the partner gets half of that.
export const LATE_MULT = 3;
export const lateFee = (totalCents) => ({ cents: totalCents * LATE_MULT, partnerCents: Math.floor((totalCents * LATE_MULT) / 2) });

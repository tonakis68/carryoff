// Prices and booking rules. The server is the only place that decides what a booking costs.
// Flat price per bag: one price for stays up to 3 hours, a higher one for longer stays. Same-day only.
export const RATES = { pack: [4, 5], med: [5, 6], large: [6, 7] }; // [up to 3 h, over 3 h], euro
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
  for (const k of Object.keys(RATES)) total += items[k] * RATES[k][idx] * 100;
  return total;
}

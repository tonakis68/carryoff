// Opening hours per weekday, Sunday first (the same shape as partners.hours).
// Each day is null (closed), [opens, closes] or [opens, closes, lunchFrom, lunchTo].
const hhmm = (s, allow24) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)) || (allow24 && String(s) === '24:00') ? String(s) : null);

export function cleanHours(h, allow24 = false) {
  if (!Array.isArray(h) || h.length !== 7) return null;
  const out = [];
  let any = false;
  for (const d of h) {
    if (d == null) { out.push(null); continue; }
    if (!Array.isArray(d) || (d.length !== 2 && d.length !== 4)) return null;
    const o = hhmm(d[0], false), c = hhmm(d[1], allow24);
    if (!o || !c || c <= o) return null;
    if (d.length === 4) {
      const f = hhmm(d[2], false), t = hhmm(d[3], false);
      if (!f || !t || f >= t || f <= o || t >= c) return null;
      out.push([o, c, f, t]);
    } else out.push([o, c]);
    any = true;
  }
  return any ? out : null;
}

import { db, eq } from '../_shared/db.js';
import { sendMail, tpl } from '../_shared/mail.js';
import { cleanHours } from '../_shared/hours.js';
import { HttpError, handler, isEmail, json, needEnv, normEmail, randRef, readJson, requireSameOrigin } from '../_shared/util.js';

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const int = (v) => Math.min(200, Math.max(0, Math.floor(+v || 0)));
const hhmm = (s) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)) ? String(s) : null);

// A business applies to become a storage partner. Saved, and the owner gets an email.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY', 'OWNER_EMAIL']);
  const b = await readJson(request);
  if (b.website) return json({ ok: true, ref: 'P-XXXX' }); // hidden field: only bots fill it in

  const email = normEmail(b.email);
  const hours = cleanHours(b.hours);
  if (b.hours != null && !hours) throw new HttpError(400, 'invalid');
  const firstOpen = hours ? hours.find(Boolean) : null;
  const a = {
    name: clean(b.name, 120), reg_address: clean(b.reg_address, 200), rep_name: clean(b.rep_name, 120), rep_position: clean(b.rep_position, 80), vat: b.vat === 'yes' ? 'yes' : b.vat === 'no' ? 'no' : '', eik: String(b.eik ?? '').replace(/\s+/g, ''), type: clean(b.type, 60), address: clean(b.address, 200),
    contact: clean(b.contact, 120), phone: clean(b.phone, 40), email,
    cap_pack: int(b.cap_pack), cap_med: int(b.cap_med), cap_large: int(b.cap_large),
    hours,
    opens: firstOpen ? firstOpen[0] : hhmm(b.opens), closes: firstOpen ? firstOpen[1] : hhmm(b.closes),
    bfrom: firstOpen ? (firstOpen[2] || '') : (hhmm(b.bfrom) || ''), bto: firstOpen ? (firstOpen[3] || '') : (hhmm(b.bto) || ''),
    days: hours ? hours.map((x, i) => (x ? i : -1)).filter((i) => i >= 0)
      : Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [],
  };
  if (!/^\d{9,13}$/.test(a.eik) || !a.vat || a.reg_address.length < 4 || a.name.length < 2 || a.address.length < 4 || a.contact.length < 2 || a.phone.length < 5 || !isEmail(email)
      || !a.opens || !a.closes || a.closes <= a.opens
      || ((a.bfrom || a.bto) && !(a.bfrom && a.bto && a.bfrom < a.bto && a.bfrom > a.opens && a.bto < a.closes)) || !a.days.length || a.cap_pack + a.cap_med + a.cap_large < 1) {
    throw new HttpError(400, 'invalid');
  }

  // Basic abuse limits.
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const same = await db.select(env, 'partner_applications', { filters: { email: eq(email), created_at: `gte.${dayAgo}` }, select: 'id' });
  const all = await db.select(env, 'partner_applications', { filters: { created_at: `gte.${hourAgo}` }, select: 'id' });
  if (same.length >= 3 || all.length >= 20) throw new HttpError(429, 'too_many');

  a.ref = randRef('P-', 4);
  try {
    await db.insert(env, 'partner_applications', a);
  } catch (e) {
    // The new columns may not exist yet: save without them. These details still reaches the owner by email.
    const { eik, reg_address, rep_name, rep_position, vat, bfrom, bto, hours: _h, ...rest } = a;
    await db.insert(env, 'partner_applications', rest);
  }
  await sendMail(env, { to: env.OWNER_EMAIL, ...tpl.applicationNotice(a) });
  return json({ ok: true, ref: a.ref });
});

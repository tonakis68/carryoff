import { db, eq } from '../_shared/db.js';
import { sendMail, tpl } from '../_shared/mail.js';
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
  const a = {
    name: clean(b.name, 120), type: clean(b.type, 60), address: clean(b.address, 200),
    contact: clean(b.contact, 120), phone: clean(b.phone, 40), email,
    cap_pack: int(b.cap_pack), cap_med: int(b.cap_med), cap_large: int(b.cap_large),
    opens: hhmm(b.opens), closes: hhmm(b.closes),
    days: Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [],
  };
  if (a.name.length < 2 || a.address.length < 4 || a.contact.length < 2 || a.phone.length < 5 || !isEmail(email)
      || !a.opens || !a.closes || a.closes <= a.opens || !a.days.length || a.cap_pack + a.cap_med + a.cap_large < 1) {
    throw new HttpError(400, 'invalid');
  }

  // Basic abuse limits.
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const same = await db.select(env, 'partner_applications', { filters: { email: eq(email), created_at: `gte.${dayAgo}` }, select: 'id' });
  const all = await db.select(env, 'partner_applications', { filters: { created_at: `gte.${hourAgo}` }, select: 'id' });
  if (same.length >= 3 || all.length >= 20) throw new HttpError(429, 'too_many');

  a.ref = randRef('P-', 4);
  await db.insert(env, 'partner_applications', a);
  await sendMail(env, { to: env.OWNER_EMAIL, ...tpl.applicationNotice(a) });
  return json({ ok: true, ref: a.ref });
});

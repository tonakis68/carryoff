import { db, eq } from '../../_shared/db.js';
import { geocode, inVarna, parseMapsPin, publicPin } from '../../_shared/geocode.js';
import { sendMail, tpl } from '../../_shared/mail.js';
import { requireRole } from '../../_shared/session.js';
import { HttpError, handler, isEmail, json, needEnv, normEmail, readJson, requireSameOrigin } from '../../_shared/util.js';

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const hhmm = (s) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)) || String(s) === '24:00' ? String(s) : null);
const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: '', ю: 'yu', я: 'ya' };
export const slug = (name) => String(name).toLowerCase().split('').map((c) => CYR[c] ?? c).join('').normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'place';

// Owner only. GET: all partners (including switched off) and applications waiting for a decision.
export const onRequestGet = handler(async ({ request, env }) => {
  await requireRole(env, request, 'owner');
  const partners = await db.select(env, 'partners', { select: 'id,name,type,area,email,phone,address,contact,cap,active,paused,hours,lat,lng,descr,created_at', order: 'created_at.desc', limit: 300 });
  const applications = await db.select(env, 'partner_applications', { filters: { status: eq('pending') }, order: 'created_at.desc', limit: 100 });
  return json({ ok: true, partners, applications });
});

// Owner only. POST: add a partner (after a visit, or approving an application) or switch one on or off.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']);
  await requireRole(env, request, 'owner');
  const b = await readJson(request);

  if (b.action === 'set_active') {
    const done = await db.update(env, 'partners', { id: eq(String(b.id || '')) }, { active: b.active === true });
    if (!done.length) throw new HttpError(404, 'not_found');
    return json({ ok: true, active: done[0].active });
  }
  if (b.action === 'delete') {
    const id = String(b.id || '');
    const used = (await db.select(env, 'bookings', { filters: { partner_id: eq(id) }, select: 'id', limit: 1 })).length
      || (await db.select(env, 'payouts', { filters: { partner_id: eq(id) }, select: 'partner_id', limit: 1 })).length;
    if (used) throw new HttpError(409, 'has_history');
    const gone = await db.remove(env, 'partners', { id: eq(id) });
    if (!gone.length) throw new HttpError(404, 'not_found');
    return json({ ok: true });
  }
  if (b.action === 'reject') {
    await db.update(env, 'partner_applications', { ref: eq(String(b.ref || '')), status: eq('pending') }, { status: 'rejected' });
    return json({ ok: true });
  }

  // --- add or update ---
  const isUpdate = b.action === 'update';
  let current = null;
  if (isUpdate) {
    current = (await db.select(env, 'partners', { filters: { id: eq(String(b.id || '')) }, limit: 1 }))[0];
    if (!current) throw new HttpError(404, 'not_found');
  }
  const name = clean(b.name, 120), address = clean(b.address, 200), email = normEmail(b.email);
  const cap = Math.floor(+b.cap || 0), opens = hhmm(b.opens), closes = hhmm(b.closes);
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
  const keepHours = isUpdate && !b.hoursChanged;
  if (name.length < 2 || !isEmail(email) || cap < 1 || cap > 500) throw new HttpError(400, 'invalid');
  if (!keepHours && (!opens || !closes || closes <= opens || !days.length)) throw new HttpError(400, 'invalid');
  const bFrom = hhmm(b.bfrom), bTo = hhmm(b.bto), hasBreak = !!(b.bfrom || b.bto);
  if (!keepHours && hasBreak && (!bFrom || !bTo || bFrom >= bTo || bFrom <= opens || bTo >= closes)) throw new HttpError(400, 'invalid');
  const phone = clean(b.phone, 40), area = clean(b.area, 60);
  if (area.length < 3 || phone.replace(/\D/g, '').length < 6) throw new HttpError(400, 'invalid');
  const day = hasBreak ? [opens, closes, bFrom, bTo] : [opens, closes];
  const newHours = keepHours ? current.hours : [0, 1, 2, 3, 4, 5, 6].map((d) => (days.includes(d) ? day : null));

  const pasted = clean(b.coords, 600);
  let c = pasted ? await parseMapsPin(pasted).catch(() => null) : null;
  if (pasted && !c) throw new HttpError(422, 'pin_unreadable');
  if (!c && !isUpdate && address.length >= 4) c = await geocode(address).catch(() => null);
  if (!c && !isUpdate) throw new HttpError(422, 'geocode_failed');
  if (c && !inVarna(c)) throw new HttpError(422, 'outside_varna');

  if (isUpdate) {
    const dup = await db.select(env, 'partners', { filters: { email: eq(email) }, select: 'id', limit: 5 });
    if (dup.some((p) => p.id !== current.id)) throw new HttpError(409, 'email_taken');
    const patch = { name, email, phone, address, contact: clean(b.contact, 120), type: clean(b.type, 60), area, descr: clean(b.desc, 300), cap, hours: newHours };
    if (c) { const pin = publicPin(current.id, c); Object.assign(patch, { lat: c.lat, lng: c.lng, pub_lat: pin.lat, pub_lng: pin.lng }); }
    const done = await db.update(env, 'partners', { id: eq(current.id) }, patch);
    return json({ ok: true, id: current.id, partner: { id: current.id, name, lat: done[0].lat, lng: done[0].lng } });
  }

  const taken = new Set((await db.select(env, 'partners', { select: 'id', limit: 1000 })).map((p) => p.id));
  let id = slug(name);
  for (let i = 2; taken.has(id); i++) id = `${slug(name).slice(0, 20)}-${i}`;
  const pin = publicPin(id, c);
  const hours = newHours;
  if ((await db.select(env, 'partners', { filters: { email: eq(email) }, select: 'id', limit: 1 })).length) throw new HttpError(409, 'email_taken');
  const row = {
    id, name, email, phone, address, contact: clean(b.contact, 120), type: clean(b.type, 60), area, descr: clean(b.desc, 300),
    perks: Array.isArray(b.perks) ? b.perks.map((x) => clean(x, 60)).filter(Boolean).slice(0, 6) : [],
    cap, hours, lat: c.lat, lng: c.lng, pub_lat: pin.lat, pub_lng: pin.lng, active: true, paused: false,
  };
  const made = await db.insert(env, 'partners', row);
  if (b.appRef) await db.update(env, 'partner_applications', { ref: eq(String(b.appRef)) }, { status: 'approved' });
  let mailed = true;
  try { await sendMail(env, { to: email, ...tpl.partnerWelcome({ name, contact: clean(b.contact, 120), origin: new URL(request.url).origin }) }); } catch { mailed = false; }
  return json({ ok: true, id, pin, mailed, partner: { id, name, lat: c.lat, lng: c.lng } }, 201);
});

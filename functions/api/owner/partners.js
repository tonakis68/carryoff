import { cleanHours } from '../../_shared/hours.js';
import { nowInVarna } from '../../_shared/pricing.js';
import { db, eq } from '../../_shared/db.js';
import { distMeters, geocode, inVarna, parseMapsPin, publicPin } from '../../_shared/geocode.js';
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
  const cols = 'id,name,type,area,email,phone,address,contact,cap,active,paused,hours,lat,lng,descr,created_at';
  const qp = (c) => db.select(env, 'partners', { select: c, order: 'created_at.desc', limit: 300 });
  const partners = await qp(`${cols},radius,circle_lat,circle_lng`).catch(() => qp(`${cols},radius`)).catch(() => qp(cols)); // new columns may not exist yet
  const applications = await db.select(env, 'partner_applications', { filters: { status: eq('pending') }, order: 'created_at.desc', limit: 100 });
  // Bags in the places right now (stored) and bags booked for today, per partner.
  const today = nowInVarna().date, usage = {};
  const u = (id) => (usage[id] ||= { stored: 0, today: 0 });
  const n = (r) => r.n_pack + r.n_med + r.n_large, bcols = 'partner_id,n_pack,n_med,n_large';
  for (const r of await db.select(env, 'bookings', { filters: { status: eq('stored') }, select: bcols, limit: 5000 })) u(r.partner_id).stored += n(r);
  for (const r of await db.select(env, 'bookings', { filters: { status: 'in.(booked,stored)', drop_date: eq(today) }, select: bcols, limit: 5000 })) u(r.partner_id).today += n(r);
  return json({ ok: true, partners, applications, usage });
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
  const multi = Array.isArray(b.hours) ? cleanHours(b.hours, true) : null;
  if (Array.isArray(b.hours) && !multi && !keepHours) throw new HttpError(400, 'invalid');
  if (!keepHours && !multi && (!opens || !closes || closes <= opens || !days.length)) throw new HttpError(400, 'invalid');
  const bFrom = hhmm(b.bfrom), bTo = hhmm(b.bto), hasBreak = !!(b.bfrom || b.bto);
  if (!keepHours && !multi && hasBreak && (!bFrom || !bTo || bFrom >= bTo || bFrom <= opens || bTo >= closes)) throw new HttpError(400, 'invalid');
  const phone = clean(b.phone, 40), area = clean(b.area, 60);
  const radius = [150, 200, 300, 500].includes(+b.radius) ? +b.radius : 200;
  if (area.length < 3 || phone.replace(/\D/g, '').length < 6) throw new HttpError(400, 'invalid');
  const day = hasBreak ? [opens, closes, bFrom, bTo] : [opens, closes];
  const newHours = keepHours ? current.hours : multi ? multi : [0, 1, 2, 3, 4, 5, 6].map((d) => (days.includes(d) ? day : null));

  const pasted = clean(b.coords, 600);
  let c = pasted ? await parseMapsPin(pasted).catch(() => null) : null;
  if (pasted && !c) throw new HttpError(422, 'pin_unreadable');
  if (!c && !isUpdate && address.length >= 4) c = await geocode(address).catch(() => null);
  if (!c && !isUpdate) throw new HttpError(422, 'geocode_failed');
  if (c && !inVarna(c)) throw new HttpError(422, 'outside_varna');
  // The circle can be moved off the pin, but the pin (and its public offset of up to 90 m) must stay inside it.
  const hasCircle = b.clat != null && b.clat !== '' && b.clng != null && b.clng !== '' && Number.isFinite(+b.clat) && Number.isFinite(+b.clng);
  const real = c || (current ? { lat: current.lat, lng: current.lng } : null);
  const circle = { circle_lat: null, circle_lng: null };
  if (hasCircle && real) {
    const cc = { lat: +b.clat, lng: +b.clng };
    if (!inVarna(cc) || distMeters(real, cc) > radius - 90) throw new HttpError(400, 'invalid');
    circle.circle_lat = +cc.lat.toFixed(6); circle.circle_lng = +cc.lng.toFixed(6);
  }

  if (isUpdate) {
    const dup = await db.select(env, 'partners', { filters: { email: eq(email) }, select: 'id', limit: 5 });
    if (dup.some((p) => p.id !== current.id)) throw new HttpError(409, 'email_taken');
    const patch = { name, email, phone, address, contact: clean(b.contact, 120), type: clean(b.type, 60), area, descr: clean(b.desc, 300), cap, hours: newHours, radius, ...circle };
    if (c) { const pin = publicPin(current.id, c); Object.assign(patch, { lat: c.lat, lng: c.lng, pub_lat: pin.lat, pub_lng: pin.lng }); }
    const done = await db.update(env, 'partners', { id: eq(current.id) }, patch).catch(async () => {
      const { radius: _r, circle_lat: _a, circle_lng: _b, ...rest } = patch; // new columns may not exist yet
      return db.update(env, 'partners', { id: eq(current.id) }, rest);
    });
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
  const made = await db.insert(env, 'partners', { ...row, radius, ...circle }).catch(() => db.insert(env, 'partners', row)); // radius column may not exist yet
  if (b.appRef) await db.update(env, 'partner_applications', { ref: eq(String(b.appRef)) }, { status: 'approved' });
  let mailed = true;
  try { await sendMail(env, { to: email, ...tpl.partnerWelcome({ name, contact: clean(b.contact, 120), origin: new URL(request.url).origin }) }); } catch { mailed = false; }
  return json({ ok: true, id, pin, mailed, partner: { id, name, lat: c.lat, lng: c.lng } }, 201);
});

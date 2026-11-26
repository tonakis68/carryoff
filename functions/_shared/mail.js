// ALL email leaves CarryOff through sendMail() in this file.
// To switch provider later (for example Brevo), change only the fetch() below.
import { db, eq } from './db.js';
import { esc } from './util.js';

const RESEND_DAILY_LIMIT = 100;   // Resend free plan
const WARN_AT = 80;               // warn the owner at this many emails in one UTC day

const FROM = (env) => env.MAIL_FROM || 'CarryOff <no-reply@carryoff.eu>';
const REPLY_TO = (env) => env.MAIL_REPLY_TO || 'hello@carryoff.eu';

async function sentToday(env) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const rows = await db.select(env, 'email_log', {
    filters: { status: eq('sent'), created_at: `gte.${start.toISOString()}` },
    select: 'id,kind',
  });
  return rows;
}

async function log(env, to, kind, status, error) {
  try {
    await db.insert(env, 'email_log', { to_email: to, kind, status, error: error ? String(error).slice(0, 500) : null });
  } catch (e) {
    console.error('email_log write failed', e && e.message);
  }
}

async function resend(env, { to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM(env), to: [to], reply_to: REPLY_TO(env), subject, html, text }),
  });
  if (!res.ok) throw new Error(`resend ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
}

// Returns true if sent, false if not. Never throws: a failed email must not break a booking or a login.
export async function sendMail(env, { to, subject, html, text, kind }) {
  try {
    const rows = await sentToday(env);
    if (rows.length >= RESEND_DAILY_LIMIT - 1) {
      await log(env, to, kind, 'blocked', 'daily limit reached');
      return false;
    }
    await resend(env, { to, subject, html, text });
    await log(env, to, kind, 'sent');
    // One warning per day when we get close to the free-plan limit.
    if (rows.length + 1 >= WARN_AT && env.OWNER_EMAIL && !rows.some((r) => r.kind === 'limit_warning') && kind !== 'limit_warning') {
      const n = rows.length + 1;
      try {
        await resend(env, {
          to: env.OWNER_EMAIL,
          subject: `CarryOff: ${n} of ${RESEND_DAILY_LIMIT} daily emails used`,
          text: `CarryOff has sent ${n} emails today. The free Resend plan stops at ${RESEND_DAILY_LIMIT} per day. If this keeps happening, move to a paid plan.`,
          html: `<p>CarryOff has sent <b>${n}</b> emails today. The free Resend plan stops at <b>${RESEND_DAILY_LIMIT}</b> per day.</p><p>If this keeps happening, move to a paid plan.</p>`,
        });
        await log(env, env.OWNER_EMAIL, 'limit_warning', 'sent');
      } catch (e) {
        await log(env, env.OWNER_EMAIL, 'limit_warning', 'failed', e.message);
      }
    }
    return true;
  } catch (e) {
    console.error('sendMail failed', kind, e && e.message);
    await log(env, to, kind, 'failed', e && e.message);
    return false;
  }
}

// ---------- Templates (plain, mobile-friendly, English; translations come later) ----------
const wrap = (title, body) =>
  `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#0f1b3d">` +
  `<div style="max-width:520px;margin:0 auto;padding:24px"><div style="font-size:22px;font-weight:700;margin-bottom:16px">Carry<span style="color:#1d4ed8">Off</span></div>` +
  `<div style="background:#fff;border-radius:12px;padding:24px"><h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>${body}</div>` +
  `<p style="font-size:12px;color:#5b6784">CarryOff · Tonakis Hospitality · Varna, Bulgaria</p></div></body></html>`;

export const tpl = {
  loginCode: (code) => ({
    kind: 'login_code',
    subject: `Your CarryOff login code: ${code}`,
    text: `Your CarryOff login code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this email.`,
    html: wrap('Your login code', `<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0">${esc(code)}</p><p>It works for 10 minutes. If you did not ask for it, ignore this email.</p>`),
  }),
  applicationNotice: (a) => ({
    kind: 'application_notice',
    subject: `New partner application: ${a.name}`,
    text: `Reference ${a.ref}\n${a.name} (${a.type || '-'})\n${a.address}\nContact: ${a.contact}, ${a.phone}, ${a.email}\nCapacity: ${a.cap_pack} backpacks, ${a.cap_med} medium, ${a.cap_large} large\nHours: ${a.opens}-${a.closes}`,
    html: wrap('New partner application',
      `<p><b>${esc(a.name)}</b> (${esc(a.type || '-')})<br>${esc(a.address)}</p><p>Contact: ${esc(a.contact)}<br>${esc(a.phone)}<br>${esc(a.email)}</p>` +
      `<p>Capacity: ${a.cap_pack} backpacks, ${a.cap_med} medium, ${a.cap_large} large<br>Hours: ${esc(a.opens)}–${esc(a.closes)}</p><p>Reference: <b>${esc(a.ref)}</b></p>`),
  }),
  // Booking emails: used from stage 2 (payments).
  bookingConfirmed: (b) => ({
    kind: 'booking_confirmed',
    subject: `Your CarryOff booking ${b.ref} is confirmed`,
    text: `Booking ${b.ref}. Show this code at ${b.place} on ${b.date} from ${b.time}. Last pick-up ${b.lastPickup}.`,
    html: wrap('Booking confirmed', `<p>Your booking code:</p><p style="font-size:28px;font-weight:700;letter-spacing:3px;margin:4px 0">${esc(b.ref)}</p><p>Show it at <b>${esc(b.place)}</b> on ${esc(b.date)} from ${esc(b.time)}. Last pick-up ${esc(b.lastPickup)}.</p>`),
  }),
  bagsReceived: (b) => ({
    kind: 'bags_received',
    subject: `Your bags are stored at ${b.place}`,
    text: `Your bags (${b.bags}) are stored at ${b.place}. Tag numbers: ${b.tags}. Last pick-up ${b.lastPickup}.`,
    html: wrap('Your bags are stored', `<p>At <b>${esc(b.place)}</b>. Tag numbers: <b>${esc(b.tags)}</b>.</p><p>Last pick-up ${esc(b.lastPickup)}.</p>`),
  }),
  bagsReturned: () => ({
    kind: 'bags_returned',
    subject: 'Your bags were handed back',
    text: 'Thank you for using CarryOff. We hope you enjoyed Varna.',
    html: wrap('Your bags were handed back', '<p>Thank you for using CarryOff. We hope you enjoyed Varna.</p>'),
  }),
  bagsRefused: () => ({
    kind: 'bags_refused',
    subject: 'Your bags could not be stored',
    text: 'The place could not accept your bags. Your payment is refunded in full.',
    html: wrap('Your bags could not be stored', '<p>The place could not accept your bags. Your payment is refunded in full.</p>'),
  }),
};

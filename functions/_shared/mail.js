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
  // Booking confirmation, sent only after Stripe confirms the payment.
  bookingConfirmed: (b) => {
    const dir = b.lat != null && b.lng != null ? `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}` : '';
    const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;margin:4px 8px 4px 0">${esc(label)}</a>`;
    return {
      kind: 'booking_confirmed',
      subject: `Your CarryOff booking ${b.ref} is confirmed`,
      text: `Booking ${b.ref} is confirmed and paid (EUR ${b.total}).\nPlace: ${b.place}, ${b.address}\nDrop-off ${b.date} at ${b.dropTime}. Pick up the same day by ${b.pickTime}.\n` +
        (dir ? `Directions: ${dir}\n` : '') + `Your booking: ${b.bookingUrl}\nShow the booking code ${b.ref} when you drop off. Keep your passport, keys, phone, cash, medication and electronics with you: bags cannot be opened while stored.`,
      html: wrap('Booking confirmed',
        `<p style="margin:0 0 4px">Your booking code:</p><p style="font-size:28px;font-weight:700;letter-spacing:3px;margin:0 0 12px">${esc(b.ref)}</p>` +
        `<p style="margin:0 0 12px"><img src="${esc(b.qrUrl)}" width="180" height="180" alt="QR code for booking ${esc(b.ref)}" style="display:block;border:1px solid #e3e8f4;border-radius:8px"></p>` +
        `<p style="margin:0 0 4px"><b>${esc(b.place)}</b><br>${esc(b.address)}</p>` +
        `<p style="margin:0 0 12px">Drop-off: <b>${esc(b.date)} at ${esc(b.dropTime)}</b><br>Pick up the same day by <b>${esc(b.pickTime)}</b><br>Bags: ${esc(b.bags)} · Paid: EUR ${esc(b.total)}</p>` +
        `<p style="margin:0 0 12px">${dir ? btn(dir, 'Get directions') : ''}${btn(b.bookingUrl, 'View my booking')}</p>` +
        `<p style="font-size:13px;color:#5b6784;margin:0">Keep your passport, keys, phone, cash, medication and electronics with you. Bags cannot be opened or accessed while stored.</p>`),
    };
  },
  bagsReceived: (b) => {
    const label = b.tagCount === 1 ? 'Tag number' : 'Tag numbers';
    return {
      kind: 'bags_received',
      subject: `Your bags are stored at ${b.place}`,
      text: `Your ${b.bags === 1 ? 'bag is' : `bags (${b.bags}) are`} stored at ${b.place}. ${label}: ${b.tags}. Last pick-up ${b.lastPickup}.`,
      html: wrap('Your bags are stored', `<p>At <b>${esc(b.place)}</b>. ${label}: <b>${esc(b.tags)}</b>.</p><p>Last pick-up: <b>${esc(b.lastPickup)}</b>.</p>`),
    };
  },
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

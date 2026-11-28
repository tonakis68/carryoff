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
  `<p style="font-size:12px;color:#5b6784">© ${new Date().getFullYear()} CarryOff. All rights reserved. · Varna, Bulgaria</p></div></body></html>`;

// First name only, tidied; empty when we have none, so emails still read well.
const first = (n) => String(n || '').trim().split(/\s+/)[0].slice(0, 40);
const hi = (n) => (first(n) ? `Hi ${esc(first(n))},` : 'Hello,');
const hiText = (n) => (first(n) ? `Hi ${first(n)},` : 'Hello,');

export const tpl = {
  loginCode: (code) => ({
    kind: 'login_code',
    subject: `Вашият код за вход в CarryOff: ${code}`,
    text: `Вашият код за вход в CarryOff е ${code}. Валиден е 10 минути. Ако не сте го поискали, игнорирайте този имейл.`,
    html: wrap('Вашият код за вход', `<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0">${esc(code)}</p><p>Кодът е валиден 10 минути. Ако не сте го поискали, игнорирайте този имейл.</p>`),
  }),
  applicationNotice: (a) => ({
    kind: 'application_notice',
    subject: `Ново заявление за партньор: ${a.name}`,
    text: `Референция ${a.ref}\n${a.name} (${a.type || '-'})\n${a.address}\nКонтакт: ${a.contact}, ${a.phone}, ${a.email}\nКапацитет: ${a.cap_pack} раници, ${a.cap_med} ръчен багаж, ${a.cap_large} големи куфара\nРаботно време: ${a.opens}-${a.closes}`,
    html: wrap('Ново заявление за партньор',
      `<p><b>${esc(a.name)}</b> (${esc(a.type || '-')})<br>${esc(a.address)}</p><p>Контакт: ${esc(a.contact)}<br>${esc(a.phone)}<br>${esc(a.email)}</p>` +
      `<p>Капацитет: ${a.cap_pack} раници, ${a.cap_med} ръчен багаж, ${a.cap_large} големи куфара<br>Работно време: ${esc(a.opens)}–${esc(a.closes)}</p><p>Референция: <b>${esc(a.ref)}</b></p>`),
  }),
  // Sent when the owner adds a partner: how to log in and what to do. Bulgarian only.
  partnerWelcome: (b) => {
    const nm = first(b.contact);
    return {
      kind: 'partner_welcome',
      subject: `Добре дошли в CarryOff, ${b.name}`,
      text: `Здравейте${nm ? ', ' + nm : ''}!\n\nБлагодарим ви, че се присъединихте към CarryOff, и че приемате пътници в ${b.name}. Радваме се да работим заедно.\n\n` +
        `Как работи:\n1. Отворете ${b.origin} на телефона и изберете „For partners“.\n2. Въведете този имейл. Изпращаме ви 6-цифрен код. Останете влезли в телефона.\n3. Когато клиент дойде, сканирайте QR кода му с камерата на телефона (или въведете кода на резервацията). Проверете багажа, запишете номер на етикет за всеки багаж, направете снимка и натиснете „Bags received“.\n4. При връщане сканирайте QR кода отново, проверете документа за самоличност и етикетите и натиснете „Bags returned“.\n\n` +
        `Получавате 0,50 € за всеки съхранен багаж, с плащане веднъж месечно по банков път. Въпроси: hello@carryoff.eu`,
      html: wrap('Добре дошли в CarryOff',
        `<p>${nm ? `Здравейте, ${esc(nm)}!` : 'Здравейте!'}<br>Благодарим ви, че се присъединихте към CarryOff. Радваме се, че <b>${esc(b.name)}</b> е наш партньор за съхранение, и че ще работим заедно.</p>` +
        `<p><b>Как работи</b></p><ol style="padding-left:20px;margin:0 0 12px"><li>Отворете <a href="${esc(b.origin)}">${esc(b.origin.replace('https://', ''))}</a> на телефона и изберете <b>For partners</b>.</li><li>Въведете този имейл. Изпращаме ви 6-цифрен код. Останете влезли в телефона.</li><li>Когато клиент дойде, сканирайте QR кода му с камерата на телефона (или въведете кода на резервацията). Проверете багажа, запишете номер на етикет за всеки багаж, направете снимка и натиснете <b>Bags received</b>.</li><li>При връщане сканирайте QR кода отново, проверете документа за самоличност и етикетите и натиснете <b>Bags returned</b>.</li></ol>` +
        `<p>Получавате <b>0,50 €</b> за всеки съхранен багаж, с плащане веднъж месечно по банков път. Въпроси: hello@carryoff.eu</p>`),
    };
  },
  // Booking confirmation, sent only after Stripe confirms the payment.
  bookingConfirmed: (b) => {
    const dir = b.lat != null && b.lng != null ? `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}` : '';
    const btn = (href, label) => `<a href="${esc(href)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;margin:4px 8px 4px 0">${esc(label)}</a>`;
    return {
      kind: 'booking_confirmed',
      subject: `Your CarryOff booking ${b.ref} is confirmed`,
      text: `${hiText(b.name)}\n\nThank you for choosing CarryOff. Your booking ${b.ref} is confirmed and paid (EUR ${b.total}).\nPlace: ${b.place}, ${b.address}\nDrop-off ${b.date} at ${b.dropTime}. Pick up the same day by ${b.pickTime}.\n` +
        (dir ? `Directions: ${dir}\n` : '') + `Your booking: ${b.bookingUrl}\nShow the booking code ${b.ref} when you drop off. Keep your passport, keys, phone, cash, medication and electronics with you: bags cannot be opened while stored.`,
      html: wrap('Booking confirmed',
        `<p style="margin:0 0 12px">${hi(b.name)}<br>Thank you for choosing CarryOff. Your bags are in good hands, and everything you need is below.</p>` +
        `<p style="margin:0 0 4px">Your booking code:</p><p style="font-size:28px;font-weight:700;letter-spacing:3px;margin:0 0 12px">${esc(b.ref)}</p>` +
        `<p style="margin:0 0 12px"><img src="${esc(b.qrUrl)}" width="180" height="180" alt="QR code for booking ${esc(b.ref)}" style="display:block;border:1px solid #e3e8f4;border-radius:8px"></p>` +
        `<p style="margin:0 0 4px"><b>${esc(b.place)}</b><br>${esc(b.address)}</p>` +
        `<p style="margin:0 0 12px">Drop-off: <b>${esc(b.date)} at ${esc(b.dropTime)}</b><br>Pick up the same day by <b>${esc(b.pickTime)}</b><br>Bags: ${esc(b.bags)} · Paid: EUR ${esc(b.total)}</p>` +
        `<p style="margin:0 0 12px">${dir ? btn(dir, 'Get directions') : ''}${btn(b.bookingUrl, 'View my booking')}</p>` +
        `<p style="font-size:13px;color:#5b6784;margin:0 0 8px">Keep your passport, keys, phone, cash, medication and electronics with you. Bags cannot be opened or accessed while stored.</p>` +
        `<p style="font-size:13px;color:#5b6784;margin:0">You agreed to our <a href="https://carryoff.eu/terms" style="color:#1d4ed8">Terms and Conditions</a> when you booked.</p>`),
    };
  },
  bagsReceived: (b) => {
    const label = b.tagCount === 1 ? 'Tag number' : 'Tag numbers';
    return {
      kind: 'bags_received',
      subject: `Your bags are stored at ${b.place}`,
      text: `${hiText(b.name)}\n\nThank you for trusting us with your luggage. Your ${b.bags === 1 ? 'bag is' : `bags (${b.bags}) are`} stored at ${b.place}. ${label}: ${b.tags}. Last pick-up ${b.lastPickup}.\n` +
        `When you collect your bags, show your booking code ${b.ref} or this link: ${b.bookingUrl}`,
      html: wrap('Your bags are stored',
        `<p style="margin:0 0 12px">${hi(b.name)}<br>Thank you for trusting us with your luggage. It is safe now, so enjoy your day.</p>` +
        `<p style="margin:0 0 12px">At <b>${esc(b.place)}</b>. ${label}: <b>${esc(b.tags)}</b>.</p>` +
        `<p style="margin:0 0 12px">Last pick-up: <b>${esc(b.lastPickup)}</b>.</p>` +
        `<p style="margin:0 0 4px"><b>When you collect your bags, show this QR code</b> and your photo ID. The place scans it to find your booking.</p>` +
        `<p style="margin:0 0 4px;font-size:24px;font-weight:700;letter-spacing:3px">${esc(b.ref)}</p>` +
        `<p style="margin:0 0 12px"><img src="${esc(b.qrUrl)}" width="180" height="180" alt="QR code for booking ${esc(b.ref)}" style="display:block;border:1px solid #e3e8f4;border-radius:8px"></p>` +
        `<p style="margin:0"><a href="${esc(b.bookingUrl)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700">View my booking</a></p>`),
    };
  },
  bagsReturned: (b = {}) => ({
    kind: 'bags_returned',
    subject: 'Your bags were handed back',
    text: `${hiText(b.name)}\n\nYour bags were handed back. Thank you for being our customer. We hope you enjoyed Varna, and we would be happy to look after your bags again.`,
    html: wrap('Thank you for being our customer', `<p>${hi(b.name)}</p><p>Your bags were handed back. Thank you for being our customer. We hope you enjoyed Varna, and we would be happy to look after your bags again.</p>`),
  }),
  bagsRefused: (b = {}) => ({
    kind: 'bags_refused',
    subject: 'Your bags could not be stored',
    text: `${hiText(b.name)}\n\nWe are sorry: the place could not accept your bags. Your payment is refunded in full. Thank you for your understanding, and please book another place if you still need storage.`,
    html: wrap('Your bags could not be stored', `<p>${hi(b.name)}</p><p>We are sorry: the place could not accept your bags. Your payment is refunded in full. Thank you for your understanding, and please book another place if you still need storage.</p>`),
  }),
};

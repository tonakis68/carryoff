import { handler, json } from '../_shared/util.js';

// Setup check: which settings exist (yes/no only, never the values) and can we reach the database?
const NAMES = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY', 'SESSION_SECRET', 'OWNER_EMAIL'];

export const onRequestGet = handler(async ({ env }) => {
  const settings = Object.fromEntries(NAMES.map((n) => [n, !!env[n]]));
  const missing = NAMES.filter((n) => !env[n]);
  settings.STRIPE_SECRET_KEY = !!env.STRIPE_SECRET_KEY; // payments: optional until stage 2 is switched on
  settings.STRIPE_WEBHOOK_SECRET = !!env.STRIPE_WEBHOOK_SECRET;
  const payments = settings.STRIPE_SECRET_KEY && settings.STRIPE_WEBHOOK_SECRET;
  let database = 'not tested', detail;
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) {
    try {
      const key = env.SUPABASE_SECRET_KEY;
      const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/partners?select=id&limit=1`, {
        headers: { apikey: key, ...(key.startsWith('eyJ') ? { authorization: `Bearer ${key}` } : {}) },
      });
      if (res.ok) database = 'ok';
      else {
        database = 'cannot connect';
        // Only the database's own error text, never any key. Example: "permission denied for table partners".
        detail = { status: res.status, message: (await res.text()).replace(/sb_secret_\S+/g, '[key]').slice(0, 200) };
      }
    } catch (e) {
      database = 'cannot connect';
      detail = { message: 'network error: the Supabase URL is probably wrong' };
    }
  }
  return json({ ok: missing.length === 0 && database === 'ok', payments, missing, settings, database, detail });
});

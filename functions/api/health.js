import { db } from '../_shared/db.js';
import { handler, json } from '../_shared/util.js';

// Setup check: which settings exist (yes/no only, never the values) and can we reach the database?
const NAMES = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RESEND_API_KEY', 'SESSION_SECRET', 'OWNER_EMAIL'];

export const onRequestGet = handler(async ({ env }) => {
  const settings = Object.fromEntries(NAMES.map((n) => [n, !!env[n]]));
  const missing = NAMES.filter((n) => !env[n]);
  let database = 'not tested';
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) {
    try {
      await db.select(env, 'partners', { limit: 1, select: 'id' });
      database = 'ok';
    } catch {
      database = 'cannot connect (wrong URL or key, or the schema was not run)';
    }
  }
  return json({ ok: missing.length === 0 && database === 'ok', missing, settings, database });
});

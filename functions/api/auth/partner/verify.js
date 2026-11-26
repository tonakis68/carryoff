import { db, eq } from '../../../_shared/db.js';
import { checkCode } from '../../../_shared/codes.js';
import { cookieHeader, makeToken } from '../../../_shared/session.js';
import { handler, needEnv, normEmail, readJson, requireSameOrigin, json } from '../../../_shared/util.js';

export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']);
  const { email: raw, code } = await readJson(request);
  const email = normEmail(raw);
  const rows = await db.select(env, 'partners', { filters: { email: eq(email), active: eq('true') }, limit: 1 });
  const partner = rows[0];
  // Run the code check even for unknown emails so timing does not give them away.
  const ok = await checkCode(env, 'partner', email, code);
  if (!partner || !ok) return json({ ok: false, error: 'wrong_code' }, 401);
  const { token, maxAge } = await makeToken(env, 'partner', partner.id);
  return json({ ok: true, partner: { id: partner.id, name: partner.name } }, 200, { 'set-cookie': cookieHeader(token, maxAge) });
});

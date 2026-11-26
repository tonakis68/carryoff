import { db, eq } from '../../../_shared/db.js';
import { checkCode } from '../../../_shared/codes.js';
import { cookieHeader, makeToken } from '../../../_shared/session.js';
import { newSecret, otpauthUri } from '../../../_shared/totp.js';
import { handler, needEnv, normEmail, readJson, requireSameOrigin, json } from '../../../_shared/util.js';

// Step 1 of the owner login: the emailed code. Success gives a 10-minute "pending" session.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'OWNER_EMAIL']);
  const { email: raw, code } = await readJson(request);
  const email = normEmail(raw);
  const ok = await checkCode(env, 'owner', email, code);
  if (!ok || email !== normEmail(env.OWNER_EMAIL)) return json({ ok: false, error: 'wrong_code' }, 401);

  let rows = await db.select(env, 'owner_settings', { filters: { id: eq(1) }, limit: 1 });
  let row = rows[0];
  if (!row) row = (await db.insert(env, 'owner_settings', { id: 1 }))[0];

  const { token, maxAge } = await makeToken(env, 'owner_pending', email);
  const headers = { 'set-cookie': cookieHeader(token, maxAge) };
  if (row.totp_enabled) return json({ ok: true, next: 'totp' }, 200, headers);

  // First time: create the secret and show it once so it can be added to the authenticator app.
  if (!row.totp_secret) {
    row = (await db.update(env, 'owner_settings', { id: eq(1) }, { totp_secret: newSecret() }))[0];
  }
  return json({ ok: true, next: 'setup', uri: otpauthUri(row.totp_secret, email), secret: row.totp_secret }, 200, headers);
});

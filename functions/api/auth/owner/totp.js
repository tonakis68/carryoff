import { db, eq } from '../../../_shared/db.js';
import { cookieHeader, makeToken, requireRole } from '../../../_shared/session.js';
import { totpVerify } from '../../../_shared/totp.js';
import { handler, needEnv, readJson, requireSameOrigin, json } from '../../../_shared/util.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Step 2 of the owner login: the 6-digit code from the authenticator app.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']);
  const pending = await requireRole(env, request, 'owner_pending');
  const { code } = await readJson(request);

  const row = (await db.select(env, 'owner_settings', { filters: { id: eq(1) }, limit: 1 }))[0];
  if (!row || !row.totp_secret) return json({ ok: false, error: 'wrong_code' }, 401);
  if (row.totp_locked_until && new Date(row.totp_locked_until) > new Date()) return json({ ok: false, error: 'locked' }, 429);

  const ok = await totpVerify(row.totp_secret, code);
  if (!ok) {
    const fails = (row.totp_fails || 0) + 1;
    await db.update(env, 'owner_settings', { id: eq(1) }, fails >= MAX_FAILS
      ? { totp_fails: 0, totp_locked_until: new Date(Date.now() + LOCK_MS).toISOString() }
      : { totp_fails: fails });
    return json({ ok: false, error: 'wrong_code' }, 401);
  }
  await db.update(env, 'owner_settings', { id: eq(1) }, { totp_fails: 0, totp_locked_until: null, totp_enabled: true });
  const { token, maxAge } = await makeToken(env, 'owner', pending.sub);
  return json({ ok: true }, 200, { 'set-cookie': cookieHeader(token, maxAge) });
});

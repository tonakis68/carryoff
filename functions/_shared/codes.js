// One-time email codes: 6 digits, valid 10 minutes, 5 tries, stored hashed.
import { db, eq } from './db.js';
import { hmacBytes, randDigits, timingEq, toHex } from './util.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_SENDS_PER_HOUR = 5;
const MAX_TRIES = 5;

const hashCode = async (env, role, email, code) => toHex(await hmacBytes(env.SESSION_SECRET, `${role}|${email}|${code}`));

// Returns the code, or null if this email asked for too many codes this hour.
export async function issueCode(env, role, email) {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await db.select(env, 'login_codes', {
    filters: { role: eq(role), email: eq(email), created_at: `gte.${since}` },
    select: 'id',
  });
  if (recent.length >= MAX_SENDS_PER_HOUR) return null;
  const code = randDigits(6);
  await db.insert(env, 'login_codes', {
    role,
    email,
    code_hash: await hashCode(env, role, email, code),
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  });
  return code;
}

export async function checkCode(env, role, email, code) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const rows = await db.select(env, 'login_codes', {
    filters: { role: eq(role), email: eq(email), used: eq('false'), expires_at: `gt.${new Date().toISOString()}` },
    order: 'created_at.desc',
    limit: 1,
  });
  const row = rows[0];
  if (!row || row.attempts >= MAX_TRIES) return false;
  // Count the try first, so parallel guesses cannot beat the limit.
  await db.update(env, 'login_codes', { id: eq(row.id) }, { attempts: row.attempts + 1 });
  const ok = timingEq(row.code_hash, await hashCode(env, role, email, code));
  if (ok) await db.update(env, 'login_codes', { id: eq(row.id) }, { used: true });
  return ok;
}

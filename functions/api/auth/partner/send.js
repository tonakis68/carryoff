import { db, eq } from '../../../_shared/db.js';
import { issueCode } from '../../../_shared/codes.js';
import { sendMail, tpl } from '../../../_shared/mail.js';
import { handler, isEmail, needEnv, normEmail, readJson, requireSameOrigin, json } from '../../../_shared/util.js';

// Always answers "ok" so nobody can use this to find out which emails are partners.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'RESEND_API_KEY']);
  const { email: raw } = await readJson(request);
  const email = normEmail(raw);
  if (!isEmail(email)) return json({ ok: true });
  const rows = await db.select(env, 'partners', { filters: { email: eq(email), active: eq('true') }, limit: 1 });
  if (rows.length) {
    const code = await issueCode(env, 'partner', email);
    if (code) {
      const m = tpl.loginCode(code);
      await sendMail(env, { to: email, ...m });
    }
  }
  return json({ ok: true });
});

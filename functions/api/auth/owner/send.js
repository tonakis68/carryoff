import { issueCode } from '../../../_shared/codes.js';
import { sendMail, tpl } from '../../../_shared/mail.js';
import { handler, needEnv, normEmail, readJson, requireSameOrigin, json } from '../../../_shared/util.js';

// Only the address in OWNER_EMAIL can ever get an owner code. Always answers "ok".
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET', 'RESEND_API_KEY', 'OWNER_EMAIL']);
  const { email: raw } = await readJson(request);
  const email = normEmail(raw);
  if (email && email === normEmail(env.OWNER_EMAIL)) {
    const code = await issueCode(env, 'owner', email);
    if (code) await sendMail(env, { to: email, ...tpl.loginCode(code) });
  }
  return json({ ok: true });
});

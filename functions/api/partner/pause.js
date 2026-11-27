import { db, eq } from '../../_shared/db.js';
import { requireRole } from '../../_shared/session.js';
import { handler, json, needEnv, readJson, requireSameOrigin } from '../../_shared/util.js';

// "We are full": stop or restart new bookings for this partner's place.
export const onRequestPost = handler(async ({ request, env }) => {
  requireSameOrigin(request);
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']);
  const s = await requireRole(env, request, 'partner');
  const b = await readJson(request);
  const paused = b.paused === true;
  await db.update(env, 'partners', { id: eq(s.sub) }, { paused });
  return json({ ok: true, paused });
});

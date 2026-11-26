import { db, eq } from '../_shared/db.js';
import { getSession } from '../_shared/session.js';
import { handler, json } from '../_shared/util.js';

// Who is logged in right now? Used by the page on load.
export const onRequestGet = handler(async ({ request, env }) => {
  if (!env.SESSION_SECRET) return json({ ok: true, role: null, configured: false });
  const s = await getSession(env, request);
  if (!s || s.role === 'owner_pending') return json({ ok: true, role: null, configured: true });
  if (s.role === 'owner') return json({ ok: true, role: 'owner', configured: true });
  const p = (await db.select(env, 'partners', { filters: { id: eq(s.sub), active: eq('true') }, limit: 1 }))[0];
  if (!p) return json({ ok: true, role: null, configured: true });
  return json({ ok: true, role: 'partner', partner: { id: p.id, name: p.name }, configured: true });
});

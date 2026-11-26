import { clearCookie } from '../../_shared/session.js';
import { handler, json, requireSameOrigin } from '../../_shared/util.js';

export const onRequestPost = handler(async ({ request }) => {
  requireSameOrigin(request);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
});

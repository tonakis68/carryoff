import { bookToken } from '../_shared/booktoken.js';
import { qrPng } from '../_shared/qr.js';
import { HttpError, handler, timingEq } from '../_shared/util.js';

// The QR image used in the confirmation email. The QR holds the signed booking link.
export const onRequestGet = handler(async ({ request, env }) => {
  const u = new URL(request.url);
  const ref = String(u.searchParams.get('ref') || '').toUpperCase(), k = u.searchParams.get('k') || '';
  if (!/^CO-[A-Z0-9]{5}$/.test(ref) || !timingEq(k, await bookToken(env, ref))) throw new HttpError(404, 'not_found');
  return new Response(qrPng(`${u.origin}/?b=${ref}&k=${k}`), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400' } });
});

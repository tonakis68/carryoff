// A booking link proves itself with a signed token, so nobody can read a booking by guessing a reference.
import { hmacBytes, toB64u } from './util.js';
export async function bookToken(env, ref) {
  return toB64u(await hmacBytes(env.SESSION_SECRET, 'booking:' + ref)).slice(0, 24);
}

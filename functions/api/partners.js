import { bookedBags } from '../_shared/capacity.js';
import { db } from '../_shared/db.js';
import { nowInVarna } from '../_shared/pricing.js';
import { handler, json, needEnv } from '../_shared/util.js';

// Public list of storage places for the map. Only approximate pins: no street address, no exact position, no contact details.
export const onRequestGet = handler(async ({ env }) => {
  needEnv(env, ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']);
  const q = (cols) => db.select(env, 'partners', { filters: { active: 'eq.true' }, select: cols, order: 'name.asc', limit: 300 });
  const base = 'id,type,area,descr,perks,cap,hours,paused,pub_lat,pub_lng';
  const rows = await q(`${base},radius`).catch(() => q(base)); // radius column may not exist yet
  const places = rows.filter((p) => p.pub_lat != null && p.pub_lng != null && Array.isArray(p.hours))
    .map((p) => ({ id: p.id, type: p.type || '', area: p.area || '', desc: p.descr || '', perks: p.perks || [], cap: p.cap, hours: p.hours, paused: !!p.paused, lat: p.pub_lat, lng: p.pub_lng, radius: p.radius || 0 }));
  const booked = await bookedBags(env, { from: nowInVarna().date });
  return json({ ok: true, places, booked }, 200, { 'cache-control': 'public, max-age=15' });
});

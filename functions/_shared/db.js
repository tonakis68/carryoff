// Minimal Supabase (PostgREST) client. Uses the SECRET key, server side only.
// Supports both key styles: new "sb_secret_..." keys and legacy "service_role" JWTs.
import { HttpError } from './util.js';

function headers(env, extra = {}) {
  const key = env.SUPABASE_SECRET_KEY;
  const h = { apikey: key, 'content-type': 'application/json', ...extra };
  if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`; // legacy JWT keys only
  return h;
}

async function call(env, method, path, body, extra) {
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method,
    headers: headers(env, extra),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    console.error('supabase', method, path.split('?')[0], res.status, msg.slice(0, 300));
    let why = msg; try { why = JSON.parse(msg).message || msg; } catch {}
    throw new HttpError(502, 'db_error');
  }
  const text = await res.text();
  return text ? JSON.parse(text) : [];
}

// filters: { column: 'eq.value' | 'gte.value' | ... } exactly as PostgREST expects.
function qs({ filters = {}, order, limit, select = '*' } = {}) {
  const p = new URLSearchParams({ select });
  for (const [k, v] of Object.entries(filters)) p.append(k, v);
  if (order) p.set('order', order);
  if (limit) p.set('limit', String(limit));
  return p.toString();
}

export const db = {
  select: (env, table, opts) => call(env, 'GET', `${table}?${qs(opts)}`),
  insert: (env, table, row) => call(env, 'POST', table, row, { prefer: 'return=representation' }),
  update: (env, table, filters, patch) =>
    call(env, 'PATCH', `${table}?${qs({ filters, select: '*' })}`, patch, { prefer: 'return=representation' }),
  upsert: (env, table, row, onConflict) =>
    call(env, 'POST', `${table}?on_conflict=${onConflict}`, row, {
      prefer: 'return=representation,resolution=merge-duplicates',
    }),
};

export const eq = (v) => `eq.${v}`;

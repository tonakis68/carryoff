// Address -> coordinates with OpenStreetMap's Nominatim (free, low volume: owner adds a handful of partners).
export async function geocode(address) {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.search = new URLSearchParams({ q: `${address}, Varna, Bulgaria`, format: 'json', limit: '1', countrycodes: 'bg' }).toString();
  const r = await fetch(u, { headers: { 'user-agent': 'CarryOff/1.0 (hello@carryoff.eu)', accept: 'application/json' } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => []);
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}

// "43.2051, 27.9102" as copied from Google Maps.
export function parseCoords(s) {
  const m = String(s || '').match(/^\s*(-?\d{1,3}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)\s*$/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}

export const inVarna = (c) => c.lat > 43.10 && c.lat < 43.32 && c.lng > 27.75 && c.lng < 28.10;

// The public pin sits 40 to 90 m from the real door, always the same for one partner, so it never gives the exact place away.
export function publicPin(id, c) {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const ang = ((h % 3600) / 3600) * 2 * Math.PI, dist = 40 + ((h >>> 12) % 50);
  return { lat: +(c.lat + (dist * Math.cos(ang)) / 111320).toFixed(5), lng: +(c.lng + (dist * Math.sin(ang)) / (111320 * Math.cos((c.lat * Math.PI) / 180))).toFixed(5) };
}

// Whatever Google Maps gives when you share a pin: plain "43.2, 27.9", a long link (…@43.2,27.9,17z / …!3d43.2!4d27.9 / …?q=43.2,27.9),
// or a short maps.app.goo.gl link, with or without the place name the phone puts in front of it.
function fromText(t) {
  let m = t.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (!m) m = t.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (!m) m = t.match(/[?&](?:q|query|ll|destination|center)=(-?\d{1,3}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i);
  if (!m) m = t.match(/(-?\d{1,3}\.\d{3,})\s*[,; ]\s*(-?\d{1,3}\.\d{3,})/);
  return m ? { lat: +m[1], lng: +m[2] } : null;
}
export async function parseMapsPin(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const plain = parseCoords(raw);
  if (plain) return plain;
  let url = (raw.match(/https?:\/\/[^\s<>"']+/) || [])[0];
  let text = raw;
  try { text = decodeURIComponent(raw); } catch {}
  const direct = fromText(text);
  if (direct) return direct;
  // Follow a short link a few steps (maps.app.goo.gl, goo.gl/maps) and read the position from where it lands.
  for (let i = 0; url && i < 5; i++) {
    const host = new URL(url).hostname;
    if (!/(^|\.)(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl)$/.test(host)) return null;
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; CarryOff/1.0)' } });
    const loc = r.headers.get('location');
    if (loc) {
      url = new URL(loc, url).toString();
      let t = url;
      try { t = decodeURIComponent(url); } catch {}
      const c = fromText(t);
      if (c) return c;
      continue;
    }
    const body = await r.text().catch(() => '');
    return fromText(body.slice(0, 200000));
  }
  return null;
}

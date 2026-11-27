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

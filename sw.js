/* CarryOff service worker.
   Purpose: make the site installable and show a friendly page when offline.
   It never caches or intercepts /api/ requests, so bookings, availability and partner data are always live. */
const VERSION = 'v1';
const STATIC = 'carryoff-static-' + VERSION;
const PRECACHE = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('carryoff-') && k !== STATIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;       // map tiles, fonts, Stripe etc. go straight to the network
  if (url.pathname.startsWith('/api/')) return;           // live data is never cached

  if (req.mode === 'navigate') {                          // pages: network first, offline page if the network fails
    e.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
    return;
  }
  if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/vendor/')) {   // static files: cache first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});

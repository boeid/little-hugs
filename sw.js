/* Web app only: keeps a copy of the app's own files so it opens without internet.
   Each file is answered from the copy at once and refreshed in the background, so an update
   to the app shows the second time it is opened. Requests to other sites (GitHub, the product
   databases) are not touched. */
const CACHE = 'littlehugs-v2';
const SHELL = ['./', 'style.css', 'app.js', 'sync.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'd/index.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// A reminder sent by the reminder server (BabyCare/worker): show it. iOS requires every push to show a notification.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Little Hugs', { body: d.body || '', icon: 'icon-192.png' }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow('./')));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; });
    if (hit) { e.waitUntil(fresh.catch(() => { })); return hit; }
    return fresh;
  }));
});

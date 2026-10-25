'use strict';
// Offline shell: the app opens with no signal (basements, culverts, remote sites). Transactions made offline
// are queued by the page itself (app.js) and replayed with their original idempotency keys.
const CACHE = 'salut-shell-v3';
const SHELL = ['/', '/styles.css', '/common.js', '/app.js', '/manifest.webmanifest', '/favicon-64.png', '/brand/salut-wordmark.png', '/brand/salut-mark.png', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/vendor/jsQR.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/bootstrap') return;        // never cache anything else from the API
  if (url.pathname.startsWith('/admin')) return;                                              // admin is online-only
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);                                                         // network first → always current
      if (fresh.ok) { const c = await caches.open(CACHE); c.put(url.pathname.startsWith('/e/') ? '/' : req, fresh.clone()); }
      return fresh;
    } catch {
      const c = await caches.open(CACHE);
      return (await c.match(url.pathname.startsWith('/e/') ? '/' : req)) || (req.mode === 'navigate' ? c.match('/') : Response.error());
    }
  })());
});

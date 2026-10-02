/* Veo — offline cache.
   Strategy: precache the shell, then stale-while-revalidate for same-origin GETs.
   Navigations fall back to the cached index.html so the SPA boots offline.

   The agent's API (`/agent/*`) is excluded from all of it. Two reasons, and
   the second is the important one:

   1. Freshness. These responses are views of mutable state — pinning a
      memory and re-reading the list returned the pre-pin copy, and the UI
      looked broken for a reason that was nowhere in the UI.
   2. Shredding. Caching them would write a plaintext copy of someone's
      memory into CacheStorage, where it would outlive the "forget" that was
      supposed to destroy it. An agent that promises crypto-shredding cannot
      quietly keep a second copy in the browser. */

/* The build id and precache list below are injected at build time (vite.config.ts). */
const VERSION = 'veo-__BUILD_ID__';
const SHELL = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/photos/ceramics.jpg',
  '/photos/golden-hour.jpg',
  ...['__PRECACHE__'].filter((x) => x !== '__PRECACHE__'),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never the agent: not cached, not served stale, not stored. Straight to
  // the network, and if the network is down the caller hears about it.
  if (url.pathname === '/agent' || url.pathname.startsWith('/agent/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

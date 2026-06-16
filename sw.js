/* Command Center — service worker.
 *
 * Design goal: make the installed app open instantly and work offline, WITHOUT
 * ever breaking the Phase-1 guarantee that code pushes ship with no reinstall.
 *
 * Strategy:
 *   - The app document (index.html / navigations) is NETWORK-FIRST. When online
 *     you always get the freshest deploy; the cache is only a fallback for when
 *     the network is unavailable. So a `git push` ships on the very next online
 *     open — the service worker never pins you to a stale build.
 *   - Static assets (icons, manifest, Google Fonts, the supabase-js CDN bundle)
 *     are STALE-WHILE-REVALIDATE: served instantly from cache, refreshed in the
 *     background.
 *   - Supabase API / Realtime traffic is never touched — it must always hit the
 *     network so live data and auth work normally.
 *
 * Bump VERSION to invalidate all old caches on the next activation.
 */
const VERSION = 'cc-v1';
const STATIC_CACHE = `${VERSION}-static`;

// Same-origin shell assets worth precaching so the very first offline launch works.
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isSupabase(url) {
  return url.hostname.endsWith('supabase.co') ||
         url.hostname.endsWith('supabase.in') ||
         url.hostname.includes('supabase');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // Never intercept Supabase (DB / auth / realtime) — always hit the network.
  if (isSupabase(url)) return;
  // Don't try to cache websockets / EventSource.
  if (req.headers.get('upgrade') === 'websocket') return;

  // App document → network-first (fresh deploys ship immediately; cache is fallback).
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(STATIC_CACHE);
        cache.put(req, fresh.clone()).catch(() => {});
        cache.put('./', fresh.clone()).catch(() => {}); // stable offline-fallback key
        return fresh;
      } catch {
        return (await caches.match(req)) ||
               (await caches.match('./')) ||
               (await caches.match('./index.html')) ||
               Response.error();
      }
    })());
    return;
  }

  // Everything else (icons, manifest, fonts, supabase-js CDN) → stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(req);
    const network = fetch(req)
      .then((res) => {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      })
      .catch(() => cached);
    return cached || network;
  })());
});

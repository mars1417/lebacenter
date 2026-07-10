// 乐吧公益中心 — Service Worker
// 固定入口: mars1417.github.io/lebacenter/
const CACHE = 'leba-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      '/lebacenter/',
      '/lebacenter/manifest.json',
      '/lebacenter/icon-192.png',
      '/lebacenter/icon-512.png'
    ]))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

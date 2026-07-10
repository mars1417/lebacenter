// 乐吧公益中心 — Service Worker v2
// 核心改进: 入口页永不用缓存（network-first），静态资源用缓存
const CACHE = 'leba-v2';
const STATIC_CACHE = 'leba-static-v2';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(STATIC_CACHE).then(c => c.addAll([
      '/lebacenter/manifest.json',
      '/lebacenter/icon-192.png',
      '/lebacenter/icon-512.png'
    ]))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      clients.claim(),
      // 删除旧版缓存
      caches.keys().then(function(keys) {
        return Promise.all(
          keys.filter(function(k) { return k !== CACHE && k !== STATIC_CACHE; })
            .map(function(k) { return caches.delete(k); })
        );
      })
    ])
  );
});

self.addEventListener('fetch', (e) => {
  // 入口页（HTML导航）→ 网络优先，SW不缓存HTML
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(function(res) { return res; })
        .catch(function() { return caches.match(e.request); })
    );
    return;
  }
  // 静态资源 → 缓存优先
  e.respondWith(
    caches.match(e.request).then(function(r) { return r || fetch(e.request); })
  );
});

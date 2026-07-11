// 乐吧公益中心 — Service Worker v3
// 强制刷新：更新cache版本，清除所有旧缓存
const CACHE = 'leba-v3';
const STATIC_CACHE = 'leba-static-v3';

const PRECACHE_URLS = [
  '/lebacenter/manifest.json',
  '/lebacenter/icon-192.png',
  '/lebacenter/icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(STATIC_CACHE).then(c => c.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      clients.claim(),
      // 删除所有旧版缓存（leba-v2及更早版本）
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
  // 入口页（HTML）→ 始终从网络获取，不信任缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'})
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

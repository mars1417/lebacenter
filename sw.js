// 乐吧公益中心 — Service Worker v9
// v9: 缓存优先 + 下载即写入（视频第一次下载后存入缓存，第二次起直接读缓存秒开）
const CACHE = 'leba-v9';
const STATIC_CACHE = 'leba-static-v9';

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
      // 删除所有旧版缓存（v7及更早版本）
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
  // 🔑 v8: 缓存优先；未命中→下载并写入缓存（视频等大文件下次直接读缓存）
  e.respondWith(
    caches.match(e.request).then(function(r) {
      if (r) return r;  // 命中缓存 → 直接用
      return fetch(e.request).then(function(res) {
        if (res && res.ok && e.request.url.indexOf('leba_intro') > -1) {
          // 视频下载成功 → 克隆一份存入缓存（不阻塞响应）
          var cp = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, cp); });
        }
        return res;
      });
    })
  );
});

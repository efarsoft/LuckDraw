/* Service Worker：用户页壳缓存（应对蜂窝弱网，页面秒开） */
const CACHE = 'luckydraw-shell-v13';
const SHELL = [
  '/',
  '/css/base.css?v=13',
  '/css/index.css?v=13',
  '/js/http.js?v=13',
  '/js/confetti.js?v=13',
  '/js/index.js?v=13',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // API 走网络
  // 静态资源：缓存优先；导航请求：网络优先、断网回落缓存
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
  } else {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
      if (resp.ok && (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/'))) {
        const clone = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return resp;
    })));
  }
});

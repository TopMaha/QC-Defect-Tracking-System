/* Service worker — app-shell cache (network-first สำหรับ API/รูป, cache-first สำหรับ shell) */
const CACHE = 'qc-defect-v1';
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // API และรูป: ใช้เน็ตเวิร์กก่อน (ข้อมูลต้อง real-time)
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/')) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // shell: cache-first
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
    const copy = resp.clone();
    if (resp.ok) caches.open(CACHE).then(c => c.put(e.request, copy));
    return resp;
  }).catch(() => caches.match('./index.html'))));
});

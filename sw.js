// 配達トラッカー Service Worker（オフライン起動・更新・通知タップ）
const VERSION = 'dt-v1.1.3';
const EXT = 'dt-tiles';          // 地図タイル（更新しても消さない）
const TILE_MAX = 400;            // タイル保存の上限枚数
const CORE = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './lib/leaflet.js', './lib/leaflet.css', './lib/chart.umd.js',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // 消すのは配達トラッカーの古いキャッシュ（dt- で始まるもの）だけ。せどりアプリ（sd-）のキャッシュは残す
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('dt-') && k !== VERSION && k !== EXT).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(EXT); const keys = await c.keys();
  for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) {
    // 地図タイル：保存済みを優先、裏で更新（正常な応答だけ・上限あり）
    if (/tile\.openstreetmap\.org|basemaps\.cartocdn\.com/.test(url.host)) {
      e.respondWith(caches.open(EXT).then(async c => {
        const hit = await c.match(req);
        const net = fetch(req).then(r => { if (r.ok) { c.put(req, r.clone()).then(trimTiles); } return r; }).catch(() => hit);
        return hit || net;
      }));
    }
    return; // GAS・Discord・フォントはそのまま
  }
  // アプリ本体：最新を取りに行き、3秒で返ってこなければ保存版で起動
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const net = fetch(req, { cache: 'no-cache' }).then(r => { if (r.ok) cache.put(req, r.clone()); return r; });
    const cached = await cache.match(req, { ignoreSearch: true });
    if (!cached) return net.catch(() => cache.match('./index.html'));
    const timeout = new Promise(res => setTimeout(() => res(cached), 3000));
    return Promise.race([net.catch(() => cached), timeout]);
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./index.html');
    })
  );
});

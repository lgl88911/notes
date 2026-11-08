const VERSION = 'v5';
const SHELL_CACHE = `notestream-shell-${VERSION}`;
const MEDIA_CACHE = 'notestream-media';
const MEDIA_MAX_ENTRIES = 260;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/ui.js',
  './js/store.js',
  './js/db.js',
  './js/gh.js',
  './js/media.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('notestream-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GitHub API 不缓存，避免读到过期数据
  if (url.host === 'api.github.com') return;

  // 媒体文件：缓存优先
  if (url.host === 'raw.githubusercontent.com') {
    e.respondWith(cacheFirst(req, MEDIA_CACHE));
    return;
  }

  if (url.origin === location.origin) {
    // 界面文件一律「先网络、失败才用缓存」：改了代码下次打开就是新的，
    // 离线时仍然能打开。之前用 stale-while-revalidate，会先吐旧文件，
    // 于是手机上经常看到上一版的界面。
    e.respondWith(networkFirst(req, SHELL_CACHE));
  }
});

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    const shell = await cache.match('./index.html');
    return shell || new Response('', { status: 504 });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MEDIA_MAX_ENTRIES) return;
  const drop = keys.slice(0, keys.length - MEDIA_MAX_ENTRIES);
  await Promise.all(drop.map((k) => cache.delete(k)));
}

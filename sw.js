const VERSION = 'v1';
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
    if (req.mode === 'navigate') {
      e.respondWith((async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch {
          return (await caches.match('./index.html')) || Response.error();
        }
      })());
      return;
    }
    e.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});

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

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || network;
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MEDIA_MAX_ENTRIES) return;
  const drop = keys.slice(0, keys.length - MEDIA_MAX_ENTRIES);
  await Promise.all(drop.map((k) => cache.delete(k)));
}

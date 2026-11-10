// ===== Service Worker =====
//
// 目标：装到桌面以后，没网也能打开，看到的是缓存下来的内容。
//
// 做法上跟以前有三处不同：
//   1. 预缓存逐个文件来（以前是 cache.addAll，一个文件失败整批白做），
//      失败的记下来，下次启动 / 联网时再补。
//   2. 导航请求单独处理：任何地址打开都往 index.html 这个键上留一份，
//      离线时先按原地址找，找不到再退到 index.html。
//   3. 资源找不到缓存就回 504，不再拿 index.html 顶替 JS/CSS（那样只会白屏）。

const VERSION = 'v14';
const SHELL_CACHE = `notestream-shell-${VERSION}`;
const MEDIA_CACHE = 'notestream-media';
const MEDIA_MAX_ENTRIES = 300;
const INDEX = './index.html';

const SHELL = [
  './',
  INDEX,
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/update.js',
  './js/ui.js',
  './js/store.js',
  './js/db.js',
  './js/gh.js',
  './js/media.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

/* ==================== 安装 / 激活 ==================== */

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    await precacheShell();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('notestream-shell-') && k !== SHELL_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
    // 刚接管，如果还有没缓存到的文件，趁这会儿大概连着网，再补一次
    precacheShell().catch(() => {});
  })());
});

/**
 * 逐个文件预缓存。任何一个失败都不影响其他文件，返回没缓存上的列表。
 * 用 cache: 'reload' 绕开 GitHub Pages 的 max-age=600，避免把旧文件固化进缓存。
 */
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const missing = [];
  await Promise.all(SHELL.map(async (url) => {
    // 统一换成绝对地址：Request 和 Cache 都能稳定认，也不依赖调用时的基准
    const abs = new URL(url, self.location).href;
    if (await cache.match(abs, { ignoreSearch: true })) return;
    try {
      const res = await fetch(abs, { cache: 'reload' });
      if (!res.ok) throw new Error(String(res.status));
      await cache.put(abs, res);
    } catch {
      missing.push(url);
    }
  }));
  if (missing.length) console.warn('[sw] 预缓存没完成：', missing.join(', '));
  return missing;
}

/* ==================== 取文件 ==================== */

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

  if (url.origin !== location.origin) return;

  // 部署标记：永远直连网络，不缓存。App 靠它判断线上有没有新版。
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => new Response('{}', {
      headers: { 'content-type': 'application/json' },
    })));
    return;
  }

  // 打开页面本身：能不能离线打开就看这一路
  if (req.mode === 'navigate') {
    e.respondWith(navigationResponse(req));
    return;
  }

  e.respondWith(networkFirst(req, SHELL_CACHE));
});

async function navigationResponse(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // cache: 'no-cache' 强制用 ETag 回源校验，没变就是 304，几乎不花流量
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) {
      // 不论用什么地址打开（带参数、走 /notes/ 还是 /notes/index.html），
      // 都同时按原地址和 index.html 各存一份，离线回退才有得可用
      cache.put(new URL(INDEX, self.location).href, res.clone());
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const indexUrl = new URL(INDEX, self.location).href;
    const rootUrl = new URL('./', self.location).href;
    const hit = (await cache.match(req, { ignoreSearch: true }))
      || (await cache.match(indexUrl))
      || (await cache.match(rootUrl));
    return hit || offlinePage();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // 关键：GitHub Pages 给静态资源带了 max-age=600 的 CDN 缓存头，
    // 普通 fetch(req) 会命中浏览器 HTTP 缓存，最多能拿到 10 分钟前的旧文件。
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
    if (hit) return hit;
    // 不要拿 index.html 顶替 JS/CSS，那只会让页面白屏且看不出原因
    return new Response('', { status: 504, statusText: 'offline' });
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
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MEDIA_MAX_ENTRIES) return;
  const drop = keys.slice(0, keys.length - MEDIA_MAX_ENTRIES);
  await Promise.all(drop.map((k) => cache.delete(k)));
}

/** 连缓存都没有的时候，至少给一页人话，而不是浏览器的断网提示 */
function offlinePage() {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>随想 · 离线</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
    padding: 32px; background: #f8f7f4; color: #1b1a17;
    font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: #100f0e; color: #eceae4; } }
  .box { max-width: 300px; text-align: center; line-height: 1.7; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0 0 20px; font-size: 14px; opacity: .7; }
  button { font: inherit; font-size: 15px; padding: 9px 20px; border-radius: 10px;
    border: 1px solid currentColor; background: none; color: inherit; }
</style></head><body><div class="box">
<h1>现在没有离线副本</h1>
<p>联网打开一次，界面文件就会存到本机，之后没网也能用。</p>
<button onclick="location.reload()">重试</button>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* ==================== 与页面通信 ==================== */

// 页面加载完会发 {type:'precache'} 让我们把界面文件补一遍；
// 设置面板会发 {type:'status'} 问离线副本齐不齐。
self.addEventListener('message', (e) => {
  const data = e.data || {};

  if (data.type === 'precache') {
    const job = precacheShell();
    if (e.waitUntil) e.waitUntil(job);
    else job.catch(() => {});
    return;
  }

  if (data.type === 'status') {
    const job = shellStatus().then((s) => {
      if (e.ports && e.ports[0]) e.ports[0].postMessage(s);
    }).catch(() => {});
    if (e.waitUntil) e.waitUntil(job);
  }
});

async function shellStatus() {
  const cache = await caches.open(SHELL_CACHE);
  const keys = await cache.keys();
  const have = new Set(keys.map((k) => new URL(k.url).pathname));
  const missing = SHELL.filter((u) => !have.has(new URL(u, self.location).pathname));
  return { version: VERSION, total: SHELL.length, cached: SHELL.length - missing.length, missing };
}

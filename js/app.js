// ===== 启动 =====

import { store } from './store.js';
import { initUI, openSetup } from './ui.js';
import { requestPersistence } from './db.js';
import { toast } from './util.js';

async function boot() {
  const bootEl = document.getElementById('boot');
  try {
    await requestPersistence();
    await store.loadConfig();
  } catch (e) {
    console.error('配置读取失败', e);
  }

  initUI();

  const app = document.getElementById('app');
  if (store.hasConfig()) {
    app.hidden = false;
    try {
      await store.init();
    } catch (e) {
      console.error(e);
      toast('初始化失败：' + e.message);
    }
  } else {
    app.hidden = true;
    openSetup(false);
  }

  if (bootEl) bootEl.hidden = true;

  window.addEventListener('online', () => {
    store.flushQueue();
    store.refreshTree({ quiet: true }).catch(() => {});
  });
  window.addEventListener('offline', () => {
    toast('已离线，新笔记会先存在本地');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.hasConfig()) {
      store.flushQueue();
      const age = Date.now() - (store.remote.fetchedAt || 0);
      if (age > 60_000) store.refreshTree({ quiet: true }).catch(() => {});
    }
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    // updateViaCache: 'none' 让浏览器每次都真的去取 sw.js，而不是吃 HTTP 缓存
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    }).catch(() => {});

    // 新版本接管后自动刷新一次，避免「改了代码但手机还是旧界面」
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
  }
}

boot();

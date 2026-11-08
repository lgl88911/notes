// ===== 启动 =====

import { store } from './store.js';
import { initUI, openSetup } from './ui.js';
import { requestPersistence } from './db.js';
import { toast } from './util.js';
import { createUpdater } from './update.js';

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

  const updater = createUpdater({
    readVersion,
    notify: (msg) => toast(msg),
    busy: composerBusy,
  });
  updater.init();

  // 编辑结束（关闭编辑器）时，把编辑期间攒下的更新放行
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updater.settle();
  });
}

function readVersion() {
  return fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => (data && data.sha ? { sha: String(data.sha), app: data.app || null } : null))
    .catch(() => null);
}

function composerBusy() {
  const box = document.getElementById('composer');
  if (!box || box.hidden) return false;
  const text = document.getElementById('composer-text');
  return !!(text && text.value.trim());
}

boot();

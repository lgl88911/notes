// ===== 启动 =====

import { store, knownConfigured } from './store.js';
import { initUI, openSetup } from './ui.js';
import { requestPersistence, notes as dbNotes } from './db.js';
import { toast } from './util.js';
import { createUpdater } from './update.js';

async function boot() {
  const bootEl = document.getElementById('boot');
  const app = document.getElementById('app');

  // 本地缓存的笔记和配置互不依赖，一起要：串着等就是白等一次 IndexedDB
  const localNotes = dbNotes.all().catch((e) => {
    console.error('本地笔记读取失败', e);
    return null;
  });

  // 先把界面挂起来，能画的立刻画（列表部分用上次的快照），别等任何 IO
  initUI();
  if (knownConfigured()) {
    app.hidden = false;
    if (bootEl) bootEl.hidden = true;
  }

  try {
    await store.loadConfig();
  } catch (e) {
    console.error('配置读取失败', e);
  }
  // 持久化申请可能要等系统应答，不该挡住开门
  requestPersistence().catch(() => {});

  const configured = store.hasConfig();
  app.hidden = !configured;
  if (bootEl) bootEl.hidden = true;

  if (configured) {
    try {
      // 进到这里界面已经在屏幕上了；这一句只是把缓存里的真实数据换上去
      await store.init(await localNotes);
    } catch (e) {
      console.error(e);
      toast('初始化失败：' + e.message);
      store.loaded = true;
      store.emit('load');
    }
  } else {
    openSetup(false);
  }

  window.addEventListener('online', () => {
    store.flushQueue();
    store.refreshTags().catch(() => {});
    store.pullRemote().catch(() => {});
  });
  window.addEventListener('offline', () => {
    toast('已离线，新笔记会先存在本地');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && store.hasConfig()) {
      store.flushQueue();
      store.refreshTags().catch(() => {});
      const age = Date.now() - (store.remote.fetchedAt || 0);
      if (age > 60_000) {
        // 回到前台：看远端有没有新笔记（别的设备写的）或改过的
        store.pullRemote().catch(() => {});
      }
    }
  });

  const updater = createUpdater({
    readVersion,
    notify: (msg) => toast(msg),
    busy: composerBusy,
  });
  // 版本检查要联网，放到首帧之后，别跟界面加载抢资源
  const startUpdater = () => updater.init();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => setTimeout(startUpdater, 0));
  } else {
    setTimeout(startUpdater, 0);
  }

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

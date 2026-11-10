// 版本更新：让装在桌面上的 PWA 尽快跟上线上部署
//
// 手机上的 PWA 常年挂在后台不退出，光等「下次启动」会把新版本压在旧界面后面很久。
// 这里叠了四层：
//   1. 部署标记比对 —— 记住打开时的 version.json 提交号，回到前台 / 联网 /
//      定时（90 秒）各比对一次，发现线上变了就刷新
//   2. Service Worker 自检 —— 回到前台、联网时让浏览器去取一次 sw.js
//   3. 接管即刷新 —— 新 SW 接管后重载页面
//   4. 手动按钮 —— 设置里「更新到最新版本」，立即比对并强制重载
// 重载前会看有没有正在写的笔记，避免吞掉用户没发布的内容。

let active = null;

// 设置面板等处需要拿到当前这个实例
export function getUpdater() {
  return active;
}

// 版本号形如 { sha: '93cab8d…', app: 'v1.5' }；sha 用来判断，app 用来显示
export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : '';
}

// 让 Service Worker 把界面文件再补缓存一遍（离线可用靠它）
export function askPrecache() {
  const c = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
  if (c) c.postMessage({ type: 'precache' });
}

// 问 Service Worker 离线副本齐不齐；没有控制器 / 超时就返回 null
export function getOfflineStatus(timeout = 1500) {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return resolve(null);
    const c = navigator.serviceWorker.controller;
    if (!c) return resolve(null);
    let done = false;
    const ch = new MessageChannel();
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeout);
    ch.port1.onmessage = (ev) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ev.data || null);
    };
    try {
      c.postMessage({ type: 'status' }, [ch.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export function createUpdater({
  readVersion,        // () => Promise<{sha, app}|null>
  notify = () => {},  // 提示文案
  busy = () => false, // 是否正在编辑，不能打断
  reload = () => location.reload(),
  pollMs = 90_000,
  swCheckMs = 15 * 60 * 1000,
  setTimer = setInterval,
}) {
  const state = { sha: null, app: null };
  let pending = false;
  let reloading = false;
  let reg = null;
  let lastSwCheck = 0;
  let retry = null;

  function schedule() {
    if (reloading) return;
    if (busy()) {
      if (!pending) notify('新版本已就绪，退出编辑后自动更新');
      pending = true;
      // 用户可能写完就放着不动，这里自己盯着，编辑器一关就刷新
      if (!retry) retry = setTimer(settle, 15_000);
      return;
    }
    if (retry) { clearInterval(retry); retry = null; }
    pending = false;
    reloading = true;
    notify('发现新版本，正在更新…');
    setTimeout(reload, 350);
  }

  async function check() {
    if (reloading) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const v = await readVersion();
    if (!v || !v.sha) return;                            // 离线或读不到，这轮跳过
    if (!state.sha) { state.sha = v.sha; state.app = v.app; return; } // 补基线
    if (v.sha !== state.sha) schedule();
  }

  function checkSW(force) {
    if (!reg) return;
    const now = Date.now();
    if (!force && now - lastSwCheck < 60_000) return;
    lastSwCheck = now;
    reg.update().catch(() => {});
  }

  // 用户从编辑器退出来时调用，处理「更新在编辑期间到达」的情况
  function settle() {
    if (pending && !busy()) schedule();
  }

  // 只读一次线上版本，不改变基线 —— 给设置面板显示用
  async function peek() {
    return readVersion();
  }

  async function clearShellCaches() {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith('notestream-shell-')).map((k) => caches.delete(k)),
      );
    } catch { /* 无 Cache Storage 时忽略 */ }
  }

  // 设置里的「更新到最新版本」：立即比对，有新版就重载；没有就顺手清一次界面缓存
  async function forceUpdate(onStage = () => {}) {
    onStage('检查中…');
    const v = await readVersion().catch(() => null);

    // 离线时读不到版本号。这时候绝不能清界面缓存——那是离线能打开的唯一依靠
    if (!v || !v.sha) {
      onStage('没有网络');
      return { updated: false, version: null, offline: true };
    }

    const same = !!(state.sha && v.sha === state.sha);

    if (same) {
      onStage('整理本地缓存…');
      await clearShellCaches();
      return { updated: false, version: v };
    }

    onStage('正在更新…');
    await clearShellCaches();
    if (reg) await reg.update().catch(() => {});
    reloading = true;
    setTimeout(reload, 250);
    return { updated: true, version: v };
  }

  async function init() {
    const first = await readVersion().catch(() => null);
    state.sha = first && first.sha ? first.sha : null;
    state.app = first && first.app ? first.app : null;

    const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      && typeof location !== 'undefined' && location.protocol.startsWith('http');
    if (!supported) return;

    const hadController = !!navigator.serviceWorker.controller;

    try {
      reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      checkSW(true);
      // 注册完先让 SW 把界面文件补齐；装到桌面之后离线能不能打开就看这一步
      navigator.serviceWorker.ready.then(() => askPrecache()).catch(() => {});
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'activated') { askPrecache(); schedule(); }
        });
      });
      setTimer(() => checkSW(false), swCheckMs);
    } catch { /* 注册失败不阻塞使用 */ }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      askPrecache();
      if (!hadController) return; // 首次安装，本来就是这个版本
      schedule();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      settle();
      check();
      checkSW(false);
    });
    window.addEventListener('focus', () => { settle(); check(); checkSW(false); });
    window.addEventListener('online', () => { check(); checkSW(true); askPrecache(); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) { check(); checkSW(false); } });

    setTimer(() => {
      if (document.visibilityState === 'visible') check();
    }, pollMs);
  }

  const api = {
    init,
    check,
    checkSW,
    settle,
    schedule,
    peek,
    forceUpdate,
    get sha() { return state.sha; },
    get app() { return state.app; },
    get pending() { return pending; },
  };
  if (!active) active = api;
  return api;
}

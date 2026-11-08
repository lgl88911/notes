// 版本更新：让装在桌面上的 PWA 尽快跟上线上部署
//
// 手机上的 PWA 常年挂在后台不退出，光等「下次启动」会把新版本压在旧界面后面很久。
// 这里叠了三层：
//   1. 部署标记比对 —— 记住打开时的 version.json 提交号，回到前台 / 联网 /
//      定时（90 秒）各比对一次，发现线上变了就刷新
//   2. Service Worker 自检 —— 回到前台、联网时让浏览器去取一次 sw.js
//   3. 接管即刷新 —— 新 SW 接管后重载页面
// 重载前会看有没有正在写的笔记，避免吞掉用户没发布的内容。

export function createUpdater({
  readSha,          // () => Promise<string|null>
  notify = () => {}, // 提示文案
  busy = () => false, // 是否正在编辑，不能打断
  reload = () => location.reload(),
  pollMs = 90_000,
  swCheckMs = 15 * 60 * 1000,
  setTimer = setInterval,
}) {
  const state = { sha: null };
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
    const sha = await readSha();
    if (!sha) return;                       // 离线或读不到，这轮跳过
    if (!state.sha) { state.sha = sha; return; } // 启动时没读到，这轮补基线
    if (sha !== state.sha) schedule();
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

  async function init() {
    state.sha = await readSha();

    const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      && typeof location !== 'undefined' && location.protocol.startsWith('http');
    if (!supported) return;

    const hadController = !!navigator.serviceWorker.controller;

    try {
      reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      checkSW(true);
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'activated') schedule();
        });
      });
      setTimer(() => checkSW(false), swCheckMs);
    } catch { /* 注册失败不阻塞使用 */ }

    navigator.serviceWorker.addEventListener('controllerchange', () => {
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
    window.addEventListener('online', () => { check(); checkSW(true); });
    window.addEventListener('pageshow', (e) => { if (e.persisted) { check(); checkSW(false); } });

    setTimer(() => {
      if (document.visibilityState === 'visible') check();
    }, pollMs);
  }

  return {
    init,
    check,
    checkSW,
    settle,
    schedule,
    get sha() { return state.sha; },
    get pending() { return pending; },
  };
}

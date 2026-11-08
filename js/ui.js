// ===== 界面层 =====

import { store } from './store.js';
import { notes as dbNotes, blobs as dbBlobs, meta as dbMeta, storageEstimate } from './db.js';
import {
  $, $$, esc, renderText, fmtTime, fmtDayLabel, dayKey, fmtDur, fmtBytes, fmtDateShort,
  pad, toast, haptic, debounce, isoLocal,
} from './util.js';
import { compressImage, inspectVideo, createRecorder, LIMITS, objectUrl } from './media.js';

const els = {};
const APP_VERSION = 'v1.1';
let renderLimit = 30;
let loadingOlder = false;
let composerState = null;
let recorder = null;
let recTimer = 0;

/* ==================== 层级与返回键 ==================== */
// 靠一条常驻的「哨兵」历史记录把硬件返回键截下来：
// 面板打开时，返回只关最上面那一层，并立刻补回哨兵；
// 没有任何面板时再按返回，才真正退出应用。

const layers = [];
let guardReady = false;
let lastExitAttempt = 0;

function ensureGuard() {
  if (guardReady) return;
  guardReady = true;
  if (window.history.state && window.history.state.nsGuard) return;
  try { window.history.pushState({ nsGuard: true }, ''); } catch { /* 无痕模式等场景忽略 */ }
}

function layerOpened(name, close) {
  const top = layers[layers.length - 1];
  // 同一层重复打开（比如编辑器里又触发一次）不叠加，只更新关闭逻辑
  if (top && top.name === name) { top.close = close; return; }
  layers.push({ name, close });
  ensureGuard();
}

function layerClose() {
  const top = layers.pop();
  if (!top) return false;
  try { top.close(); } catch (e) { console.warn('close layer failed', top.name, e); }
  return true;
}

// 已经自行收起、但需要把层从栈里摘掉（避免多占一次返回）
function layerForget(name) {
  const top = layers[layers.length - 1];
  if (top && top.name === name) layers.pop();
}

window.addEventListener('popstate', () => {
  const top = layers[layers.length - 1];
  if (!top) {
    // 没有面板：让返回真的退出应用。500ms 内只退一步，避免连锁回退跳过页面
    const now = Date.now();
    if (now - lastExitAttempt < 500) return;
    lastExitAttempt = now;
    try { window.history.back(); } catch { /* ignore */ }
    return;
  }
  layers.pop();
  try { top.close(); } catch (e) { console.warn('close layer failed', top.name, e); }
  // 哨兵被吃掉了，补一条回去，下一次返回还能拦
  try { window.history.pushState({ nsGuard: true }, ''); } catch { /* ignore */ }
});


/* ==================== 初始化 ==================== */

export function initUI() {
  Object.assign(els, {
    app: $('#app'),
    feed: $('#feed'),
    foot: $('#feed-note'),
    spinner: $('#feed-spinner'),
    chip: $('#sync-chip'),
    composer: $('#composer'),
    composerText: $('#composer-text'),
    attachStrip: $('#attach-strip'),
    composerTitle: $('#composer-title'),
    fileImage: $('#file-image'),
    fileVideo: $('#file-video'),
    recorderEl: $('#recorder'),
    viewer: $('#viewer'),
    viewerContent: $('#viewer-content'),
    search: $('#search'),
    searchBody: $('#search-body'),
    searchInput: $('#search-input'),
    settings: $('#settings'),
    settingsBody: $('#settings-body'),
    syncBtn: $('#btn-sync'),
  });

  wireTopbar();
  wireFeed();
  wireComposer();
  wireRecorder();
  wireSearch();
  wireViewer();
  wireSettings();
  wireScroll();

  store.on(onStoreEvent);
  renderFeed();
  updateChip();
  ensureGuard();
}

function onStoreEvent(type, data) {
  if (type === 'sync' || type === 'config') updateChip();
  if (type === 'load') renderFeed();
  if (type === 'add') {
    renderLimit = Math.max(renderLimit, 30);
    renderFeed(data?.id);
  }
  if (type === 'update' || type === 'change' || type === 'remote') renderFeed();
}

/* ==================== 顶栏 ==================== */

function wireTopbar() {
  $('#btn-sync').addEventListener('click', manualSync);
  $('#btn-search').addEventListener('click', openSearch);
  $('#btn-settings').addEventListener('click', openSettings);
}

let syncBusy = false;

async function manualSync() {
  if (!store.hasConfig()) { toast('先完成仓库配置'); return; }
  if (syncBusy) return;
  syncBusy = true;
  haptic(6);
  els.syncBtn.classList.add('is-spinning');
  try {
    // 先把手上的改动推上去，再拉一次仓库的文件树，两边的状态就对上了
    await store.flushQueue();
    await store.refreshTree({ quiet: true });
    renderFeed();
    const pending = store.pendingCount();
    if (pending) toast(`${pending} 条没推上去，稍后会自动重试`);
    else toast('已和 GitHub 同步');
  } catch (e) {
    toast(`同步失败：${e.message || '网络异常'}`);
  } finally {
    syncBusy = false;
    els.syncBtn.classList.remove('is-spinning');
    updateChip();
  }
}

function updateChip() {
  const chip = els.chip;
  if (!chip) return;
  const pending = store.pendingCount();
  const syncing = store.syncState === 'syncing';
  const error = store.syncState === 'error';

  if (!store.hasConfig()) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.classList.toggle('is-syncing', syncing);
  chip.classList.toggle('is-error', error);
  if (els.syncBtn) els.syncBtn.classList.toggle('is-spinning', syncBusy || syncing);

  if (error && store.syncMessage) chip.textContent = '同步失败';
  else if (syncing) chip.textContent = '同步中';
  else if (pending) chip.textContent = `${pending} 条待同步`;
  else if (!navigator.onLine) chip.textContent = '离线';
  else chip.textContent = '已同步';
}

/* ==================== 信息流 ==================== */

function wireScroll() {
  window.addEventListener('scroll', onScroll, { passive: true });
  const topbar = $('.topbar');
  window.addEventListener('scroll', () => {
    topbar.classList.toggle('scrolled', window.scrollY > 4);
  }, { passive: true });
}

function onScroll() {
  const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 700;
  if (nearBottom) maybeLoadMore();
}

async function maybeLoadMore() {
  if (loadingOlder || !store.hasConfig()) return;
  if (renderLimit < store.notes.length) {
    renderLimit += 15;
    renderFeed();
    return;
  }
  // 本地翻到底了 → 从 GitHub 回捞更早的
  if (store.missingCount() === 0) return;
  loadingOlder = true;
  els.spinner.hidden = false;
  try {
    const n = await store.loadOlder(15);
    if (n > 0) renderLimit += n;
  } catch (e) {
    toast(e.message || '拉取失败');
  } finally {
    loadingOlder = false;
    els.spinner.hidden = true;
    renderFeed();
    updateFoot();
  }
}

function renderFeed(highlightNew = null) {
  if (!els.feed) return;
  const visible = store.notes.filter((n) => !n.deletingPending).slice(0, renderLimit);

  if (!store.notes.length) {
    const missing = store.missingCount();
    els.feed.innerHTML = missing
      ? `<div class="empty"><b>仓库里有 ${missing} 条笔记</b>本地还没有缓存，正在载入，也可以点下面的按钮。<br><button id="btn-first-load" style="margin-top:14px;border:1px solid var(--line);border-radius:20px;padding:9px 18px;color:var(--accent)">从 GitHub 载入</button></div>`
      : `<div class="empty"><b>还没有记录</b>点下面的输入框，写第一条。</div>`;
    const btn = $('#btn-first-load');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '载入中…';
      await store.loadOlder(20).catch(() => {});
      renderFeed();
    });
    updateFoot();
    return;
  }

  const parts = [];
  let lastDay = '';
  for (const n of visible) {
    const d = idToDateSafe(n.id);
    const dk = dayKey(d);
    if (dk !== lastDay) {
      parts.push(`<div class="day-sep">${esc(fmtDayLabel(d))}</div>`);
      lastDay = dk;
    }
    parts.push(noteHTML(n));
  }
  els.feed.innerHTML = parts.join('');
  if (highlightNew) {
    const el = els.feed.querySelector(`.note[data-id="${highlightNew}"]`);
    if (el) el.classList.add('just-in');
  }
  updateFoot();
  loadVisibleImages();
}

function updateFoot() {
  const foot = els.foot;
  if (!foot) return;
  if (!store.notes.length) { foot.textContent = ''; return; }
  const missing = store.missingCount();
  const oldest = idToDateSafe(store.notes[store.notes.length - 1].id);
  if (missing > 0) {
    foot.innerHTML = `本地已加载到 ${esc(fmtDateShort(oldest))}，更早的 ${missing} 条在仓库里<br>
      <button id="btn-load-older">继续往前翻</button>`;
    const btn = $('#btn-load-older');
    if (btn) btn.addEventListener('click', () => { maybeLoadMore(); });
  } else {
    foot.textContent = `已到最早一条，共 ${store.notes.length} 条`;
  }
}

function noteHTML(n, keyword) {
  const d = idToDateSafe(n.id);
  const state = n.pushError
    ? `<span class="note-state err">同步失败，稍后重试</span>`
    : n.pending
      ? `<span class="note-state">待同步</span>`
      : '';
  const text = n.text ? `<div class="note-text">${renderText(n.text, keyword)}</div>` : '';
  return `<article class="note" data-id="${esc(n.id)}">
    <div class="note-head">
      <span class="note-time">${fmtTime(d)}</span>
      ${state}
      <button class="note-more" data-act="menu" aria-label="更多">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>
      </button>
    </div>
    ${text}
    ${mediaHTML(n)}
  </article>`;
}

function mediaHTML(n) {
  if (!n.media || !n.media.length) return '';
  const imgs = n.media.filter((m) => m.t === 'image');
  const vids = n.media.filter((m) => m.t === 'video');
  const auds = n.media.filter((m) => m.t === 'audio');

  let html = '<div class="note-media">';

  if (imgs.length) {
    const single = imgs.length === 1;
    html += `<div class="media-grid ${single ? 'single' : 'multi'}">`;
    for (const m of imgs) {
      const ar = m.w && m.h ? m.w / m.h : 4 / 3;
      html += `<button class="media-item" data-act="open" data-nid="${esc(n.id)}" data-k="${esc(m.k)}"
        style="${single ? `aspect-ratio:${Math.min(Math.max(ar, 0.55), 2.4)}` : ''}">
        <img alt="" data-img="${esc(n.id)}:${esc(m.k)}">
      </button>`;
    }
    html += '</div>';
  }

  for (const m of vids) {
    html += `<button class="media-item" data-act="open" data-nid="${esc(n.id)}" data-k="${esc(m.k)}" style="aspect-ratio:${m.w && m.h ? (m.w / m.h).toFixed(3) : 1.6}">
      <div class="media-missing" style="background:var(--line-soft);color:var(--text-soft)">
        <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z" fill="currentColor" stroke="none"/></svg>
      </div>
      ${m.dur ? `<span class="media-badge">${fmtDur(m.dur)}</span>` : ''}
    </button>`;
  }

  for (const m of auds) {
    const wave = Array.isArray(m.wave) && m.wave.length ? m.wave : pseudoWave(n.id + m.k, 44);
    const bars = wave.map((v) => `<i style="height:${Math.max(8, Math.min(100, v))}%"></i>`).join('');
    html += `<div class="audio-block">
      <button class="audio-play" data-act="play-audio" data-nid="${esc(n.id)}" data-k="${esc(m.k)}" aria-label="播放">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5l11 6.5-11 6.5z"/></svg>
      </button>
      <div class="audio-meta"><div class="audio-wave-static">${bars}</div></div>
      <span class="audio-dur">${fmtDur(m.dur || 0)}</span>
    </div>`;
  }

  html += '</div>';
  return html;
}

function pseudoWave(seed, n) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const out = [];
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h, 1103515245) + 12345) >>> 0;
    out.push(18 + ((h >>> 8) % 78));
  }
  return out;
}

/* --- 图片懒加载 --- */

let io = null;
function loadVisibleImages() {
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          io.unobserve(en.target);
          const key = en.target.dataset.img;
          if (key) fillImage(en.target, key);
        }
      }
    }, { rootMargin: '400px 0px' });
  }
  $$('img[data-img]').forEach((img) => io.observe(img));
}

async function fillImage(img, key) {
  const [nid, k] = key.split(':');
  const note = store.notes.find((n) => n.id === nid);
  if (!note) return;
  const m = note.media.find((x) => x.k === k);
  const url = await resolveMediaUrl(note, m);
  if (url) {
    img.src = url;
    img.style.opacity = '1';
  } else {
    img.replaceWith(missingTile('图片暂不可用'));
  }
}

async function resolveMediaUrl(note, m) {
  if (!m) return '';
  const key = `${note.id}:${m.k}`;
  const local = await store.getBlob(note.id, m.k);
  if (local) return objectUrl(key, local);
  const fetched = await store.fetchMedia(note.id, m);
  if (fetched) return objectUrl(key, fetched);
  if (store.gh && m.p && navigator.onLine) return store.gh.rawUrl(m.p);
  return '';
}

function missingTile(msg) {
  const d = document.createElement('div');
  d.className = 'media-missing';
  d.textContent = msg;
  return d;
}

function idToDateSafe(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(id || '');
  if (!m) return new Date();
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/* ==================== 信息流交互 ==================== */

function wireFeed() {
  // 事件委托挂在 document 上，搜索结果里的笔记也能用同一套交互
  document.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const nid = act.dataset.nid;
    const k = act.dataset.k;
    if (act.dataset.act === 'menu') {
      const noteEl = act.closest('.note');
      if (noteEl) openNoteMenu(noteEl.dataset.id);
    } else if (act.dataset.act === 'open') {
      openViewer(nid, k);
    } else if (act.dataset.act === 'play-audio') {
      toggleAudio(act, nid, k);
    }
  });

  $$('#composer-bar button').forEach((b) => b.addEventListener('click', () => haptic(4)));
}

/* --- 音频播放 --- */

const audioEl = new Audio();
audioEl.preload = 'none';
let playingKey = null;

async function toggleAudio(btn, nid, k) {
  const note = store.notes.find((n) => n.id === nid);
  const m = note && note.media.find((x) => x.k === k);
  if (!m) return;
  const key = `${nid}:${k}`;

  if (playingKey === key && !audioEl.paused) {
    audioEl.pause();
    setPlaying(btn, false);
    return;
  }

  const url = await resolveMediaUrl(note, m);
  if (!url) return toast('音频暂不可用');
  if (playingKey !== key) {
    audioEl.src = url;
    playingKey = key;
  }
  await audioEl.play().catch(() => toast('播放失败'));
  $$('.audio-play').forEach((b) => setPlaying(b, false));
  setPlaying(btn, true);
}

audioEl.addEventListener('ended', () => {
  $$('.audio-play').forEach((b) => setPlaying(b, false));
  playingKey = null;
});

function setPlaying(btn, playing) {
  btn.innerHTML = playing
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5l11 6.5-11 6.5z"/></svg>';
}

/* --- 笔记操作菜单 --- */

function openNoteMenu(id) {
  const note = store.notes.find((n) => n.id === id);
  if (!note) return;
  haptic(8);
  const menu = document.createElement('div');
  menu.className = 'sheet action-menu';
  menu.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <div class="sheet-panel">
      <button class="menu-item" data-do="edit">编辑</button>
      <button class="menu-item" data-do="copy">复制文字</button>
      ${store.gh ? '<button class="menu-item" data-do="open-file">在 GitHub 上查看</button>' : ''}
      <button class="menu-item" data-do="sync">立即同步</button>
      <button class="menu-item danger" data-do="delete">删除</button>
      <button class="menu-item menu-cancel" data-close>取消</button>
    </div>`;
  document.body.appendChild(menu);

  const close = () => menu.remove();
  const dismiss = () => { layerForget('menu'); close(); };
  layerOpened('menu', close);
  menu.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return dismiss();
    const item = e.target.closest('[data-do]');
    if (!item) return;
    const what = item.dataset.do;
    dismiss();
    if (what === 'edit') openComposer({ note });
    if (what === 'copy') {
      try {
        await navigator.clipboard.writeText(note.text || '');
        toast('已复制');
      } catch { toast('复制失败'); }
    }
    if (what === 'open-file') {
      const url = `https://github.com/${store.config.owner}/${store.config.repo}/blob/${store.config.branch}/${store.notePath(note.id)}`;
      window.open(url, '_blank');
    }
    if (what === 'sync') { store.flushQueue(); toast('正在同步'); }
    if (what === 'delete') confirmDelete(note);
  });
}

async function confirmDelete(note) {
  const ok = window.confirm('删除后本地和 GitHub 仓库里的这条笔记（含图片、音频、视频）都会一起删掉，无法恢复。确定删除？');
  if (!ok) return;
  note.deletingPending = true;
  renderFeed();
  try {
    await store.deleteNote(note.id);
    toast('已删除');
    renderFeed();
  } catch (e) {
    // 已经标记为待删除，后台队列会自动重试
    toast(`同步失败，已排队重试：${e.message}`);
  }
}

/* ==================== 编辑器 ==================== */

function wireComposer() {
  $('#btn-compose').addEventListener('click', () => openComposer());
  $('#btn-quick-image').addEventListener('click', () => els.fileImage.click());
  $('#btn-quick-audio').addEventListener('click', () => openRecorder());

  $$('#composer [data-close]').forEach((b) => b.addEventListener('click', closeComposer));
  $('#btn-save-note').addEventListener('click', saveComposer);

  els.composerText.addEventListener('input', () => {
    autoGrow(els.composerText);
    updateComposerCount();
  });

  $('#tool-image').addEventListener('click', () => els.fileImage.click());
  $('#tool-audio').addEventListener('click', () => openRecorder());
  $('#tool-video').addEventListener('click', () => els.fileVideo.click());

  els.fileImage.multiple = true;
  els.fileImage.addEventListener('change', onPickImages);
  els.fileVideo.addEventListener('change', onPickVideo);

  document.addEventListener('paste', (e) => {
    if (!composerState) return;
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); addImageFiles([f]); }
      }
    }
  });
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.46) + 'px';
}

function openComposer({ note = null, attachments = [], text = '' } = {}) {
  const isEdit = !!note;
  composerState = {
    id: note ? note.id : null,
    attachments: (note ? note.media.map((m) => ({
      k: m.k, t: m.t, m: m.m, p: m.p, w: m.w, h: m.h, dur: m.dur, wave: m.wave,
      up: true, blob: null, preview: null,
    })) : []).concat(attachments),
    isEdit,
  };
  els.composer.hidden = false;
  els.composerTitle.textContent = isEdit ? '编辑笔记' : '新笔记';
  els.composerText.value = isEdit ? (note.text || '') : text;
  setTimeout(() => { els.composerText.focus(); autoGrow(els.composerText); }, 60);
  renderAttachments();
  updateComposerCount();
  previewExistingMedia();
  document.body.style.overflow = 'hidden';
  layerOpened('composer', hideComposer);
}

function closeComposer() {
  if (!layerClose()) hideComposer();
}

function hideComposer() {
  els.composer.hidden = true;
  els.composerText.value = '';
  els.attachStrip.innerHTML = '';
  composerState = null;
  document.body.style.overflow = '';
}

function updateComposerCount() {
  const len = (els.composerText.value || '').length;
  $('#composer-count').textContent = len ? `${len} 字` : '';
}

function nextMediaKey() {
  const used = new Set(composerState.attachments.map((a) => a.k));
  let i = 1;
  while (used.has(`m${i}`)) i++;
  return `m${i}`;
}

function renderAttachments() {
  const strip = els.attachStrip;
  if (!composerState || !composerState.attachments.length) { strip.innerHTML = ''; return; }
  strip.innerHTML = composerState.attachments.map((a, i) => {
    let inner;
    if (a.t === 'image') {
      const src = a.preview || (a.p && store.gh ? store.gh.rawUrl(a.p) : '');
      inner = `<img src="${esc(src)}" alt="" data-aindex="${i}">`;
    } else if (a.t === 'video') {
      inner = `<div class="attach-kind">${a.preview ? `<img src="${esc(a.preview)}">` : '视频'}<br>${fmtDur(a.dur || 0)}</div>`;
    } else {
      inner = `<div class="attach-kind">音频<br>${fmtDur(a.dur || 0)}</div>`;
    }
    return `<div class="attach-item">${inner}
      <button class="attach-del" data-del="${i}" aria-label="移除">✕</button>
    </div>`;
  }).join('');

  strip.querySelectorAll('[data-del]').forEach((b) => {
    b.addEventListener('click', () => {
      composerState.attachments.splice(Number(b.dataset.del), 1);
      renderAttachments();
    });
  });
}

async function previewExistingMedia() {
  if (!composerState) return;
  for (const a of composerState.attachments) {
    if (a.t !== 'image' || a.preview) continue;
    const note = store.notes.find((n) => n.id === composerState?.id);
    if (!note) continue;
    const m = note.media.find((x) => x.k === a.k);
    if (!m) continue;
    const url = await resolveMediaUrl(note, m);
    if (url && composerState) { a.preview = url; renderAttachments(); }
  }
}

async function addImageFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > LIMITS.maxFileBytes) { toast('图片超过 25MB，换一张吧'); continue; }
    try {
      const { blob, mime, w, h } = await compressImage(f);
      const k = composerState ? nextMediaKey() : 'm1';
      const item = { k, t: 'image', m: mime, w, h, dur: 0, blob, preview: URL.createObjectURL(blob), up: false };
      if (composerState) {
        composerState.attachments.push(item);
        renderAttachments();
      } else {
        openComposer({ attachments: [item] });
      }
    } catch (e) {
      toast('图片处理失败');
    }
  }
}

async function onPickImages(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  if (!composerState) {
    // 从底部快捷入口直接选图 → 打开编辑器
    await addImageFiles(files.slice(0, 1));
    if (files.length > 1) await addImageFiles(files.slice(1));
  } else {
    await addImageFiles(files);
  }
}

async function onPickVideo(e) {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > LIMITS.maxFileBytes) {
    toast(`视频 ${fmtBytes(file.size)}，超过 25MB 限制，请先压缩或剪短`);
    return;
  }
  const info = await inspectVideo(file);
  const item = { k: composerState ? nextMediaKey() : 'm1', t: 'video', m: file.type || 'video/mp4', w: info.w, h: info.h, dur: info.dur, blob: file, preview: null, up: false };
  if (composerState) {
    composerState.attachments.push(item);
    renderAttachments();
  } else {
    openComposer({ attachments: [item] });
  }
}

async function saveComposer() {
  if (!composerState) return;
  const text = els.composerText.value.trim();
  const att = composerState.attachments;
  if (!text && !att.length) { toast('写点什么吧'); return; }

  const btn = $('#btn-save-note');
  btn.disabled = true;
  btn.textContent = '保存中';

  try {
    const media = att.map((a) => ({
      k: a.k, t: a.t, m: a.m, w: a.w || 0, h: a.h || 0,
      dur: Math.round(a.dur || 0), wave: a.wave || null, p: a.p || null, up: a.up || false,
    }));
    const blobs = att.filter((a) => a.blob).map((a) => ({ k: a.k, blob: a.blob }));

    if (composerState.isEdit) {
      await store.updateNote(composerState.id, { text, media, blobs });
      toast('已更新');
    } else {
      await store.addNote({ text, media, blobs });
      toast('已记录');
    }
    closeComposer();
    haptic(12);
  } catch (e) {
    console.error(e);
    toast(`保存失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '发布';
  }
}

/* ==================== 录音 ==================== */

function wireRecorder() {
  $$('#recorder [data-close]').forEach((b) => b.addEventListener('click', () => closeRecorder(true)));
  $('#rec-toggle').addEventListener('click', () => toggleRecording());
  $('#rec-done').addEventListener('click', finishRecording);
  buildRecWave();
}

function buildRecWave() {
  const box = $('#rec-wave');
  box.innerHTML = Array.from({ length: 36 }, () => '<i style="height:8%"></i>').join('');
}

function openRecorder() {
  els.recorderEl.hidden = false;
  $('#rec-done').disabled = true;
  $('#rec-time').textContent = '00:00';
  $('#rec-toggle').classList.remove('recording');
  document.body.style.overflow = 'hidden';
  layerOpened('recorder', () => closeRecorder(true));
  toggleRecording(); // 打开即开始
}

async function toggleRecording() {
  const btn = $('#rec-toggle');
  if (!recorder) recorder = createRecorder();
  if (!recorder.state.recording) {
    try {
      await recorder.start();
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? '需要麦克风权限' : '无法开始录音');
      closeRecorder(true);
      return;
    }
    btn.classList.add('recording');
    $('#rec-wave').classList.add('active');
    startRecTimer();
  } else {
    await recorder.stop();
    recorder = null;
    btn.classList.remove('recording');
    $('#rec-wave').classList.remove('active');
    clearInterval(recTimer);
  }
}

function startRecTimer() {
  clearInterval(recTimer);
  const wave = $$('#rec-wave i');
  recTimer = setInterval(() => {
    if (!recorder) return;
    $('#rec-time').textContent = fmtDur(recorder.state.seconds);
    if (recorder.state.seconds > 0.5) $('#rec-done').disabled = false;
    const offset = Math.max(0, Math.floor(recorder.state.seconds * 4) % 36);
    wave.forEach((bar, i) => {
      const lvl = recorder.state.level;
      const h = 8 + Math.round(lvl * 92 * (0.5 + 0.5 * Math.sin((i + offset) * 0.7)));
      bar.style.height = `${Math.max(8, h)}%`;
    });
  }, 100);
}

async function finishRecording() {
  if (!recorder) return;
  const result = await recorder.stop();
  recorder = null;
  clearInterval(recTimer);
  layerForget('recorder');
  els.recorderEl.hidden = true;
  document.body.style.overflow = composerState ? 'hidden' : '';
  if (!result || result.dur < 0.4) { toast('录得太短了'); return; }
  const item = {
    k: composerState ? nextMediaKey() : 'm1',
    t: 'audio', m: result.mime, w: 0, h: 0, dur: result.dur, wave: result.wave,
    blob: result.blob, preview: null, up: false,
  };
  if (composerState) {
    composerState.attachments.push(item);
    renderAttachments();
  } else {
    openComposer({ attachments: [item] });
  }
}

function closeRecorder(cancel) {
  layerForget('recorder');
  if (cancel && recorder) { recorder.cancel(); recorder = null; }
  clearInterval(recTimer);
  els.recorderEl.hidden = true;
  document.body.style.overflow = composerState ? 'hidden' : '';
}

/* ==================== 查看器 ==================== */

function wireViewer() {
  $('#viewer-close').addEventListener('click', closeViewer);
  els.viewer.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeViewer();
  });
}

async function openViewer(nid, k) {
  const note = store.notes.find((n) => n.id === nid);
  if (!note) return;
  const m = note.media.find((x) => x.k === k);
  if (!m) return;
  haptic(5);
  els.viewer.hidden = false;
  layerOpened('viewer', hideViewer);
  els.viewerContent.innerHTML = '<div class="spinner" style="border-color:rgba(255,255,255,.3);border-top-color:#fff"></div>';
  const url = await resolveMediaUrl(note, m);
  if (!url) {
    els.viewerContent.innerHTML = '<div style="color:#fff;font-size:14px">加载失败</div>';
    return;
  }
  if (m.t === 'video') {
    els.viewerContent.innerHTML = `<video src="${esc(url)}" controls autoplay playsinline></video>`;
  } else {
    els.viewerContent.innerHTML = `<img src="${esc(url)}" alt="">`;
  }
}

function closeViewer() {
  if (!layerClose()) hideViewer();
}

function hideViewer() {
  els.viewer.hidden = true;
  els.viewerContent.innerHTML = '';
}

/* ==================== 搜索 ==================== */

function wireSearch() {
  $('#btn-search-close').addEventListener('click', closeSearch);
  const input = els.searchInput;
  input.addEventListener('input', debounce(runSearch, 180));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
}

function openSearch() {
  els.search.hidden = false;
  els.searchInput.value = '';
  els.searchBody.innerHTML = '';
  document.body.style.overflow = 'hidden';
  layerOpened('search', hideSearch);
  setTimeout(() => els.searchInput.focus(), 60);
}

function closeSearch() {
  if (!layerClose()) hideSearch();
}

function hideSearch() {
  els.search.hidden = true;
  document.body.style.overflow = '';
}

let searchToken = 0;

function runSearch() {
  const q = els.searchInput.value.trim();
  const token = ++searchToken;
  if (!q) { els.searchBody.innerHTML = ''; return; }
  const hits = store.searchLocal(q);
  renderSearch(hits, q, token);
}

function renderSearch(hits, q, token, extra = '') {
  const body = els.searchBody;
  if (token !== searchToken) return;
  const missing = store.missingCount();
  let html = `<div class="search-summary">本地找到 ${hits.length} 条${missing ? `，另有 ${missing} 条未缓存` : ''}</div>`;
  if (!hits.length) {
    html += `<div class="empty" style="padding:48px 12px">没有匹配的笔记</div>`;
  }
  let lastDay = '';
  for (const n of hits) {
    const d = idToDateSafe(n.id);
    const dk = dayKey(d);
    if (dk !== lastDay) { html += `<div class="day-sep">${esc(fmtDayLabel(d))}</div>`; lastDay = dk; }
    html += `<div class="search-hit">${noteHTML(n, q)}</div>`;
  }
  if (missing > 0) {
    html += `<div class="search-more">
      <div>上面只搜了本地缓存的部分</div>
      <button id="btn-deep-search">在 GitHub 上搜索全部 ${Math.min(missing, 600)} 条历史</button>
    </div>`;
  }
  html += extra;
  body.innerHTML = html;
  loadVisibleImagesIn(body);
  const deep = $('#btn-deep-search');
  if (deep) deep.addEventListener('click', () => deepSearch(q, token));
}

function loadVisibleImagesIn(root) {
  root.querySelectorAll('img[data-img]').forEach((img) => {
    const key = img.dataset.img;
    if (key) fillImage(img, key);
  });
}

async function deepSearch(q, token) {
  const body = els.searchBody;
  const btn = $('#btn-deep-search');
  if (btn) { btn.disabled = true; btn.textContent = '正在检索…'; }
  try {
    const hits = await store.searchRemote(q, {
      onProgress: (done, total) => {
        if (token !== searchToken) return;
        const el = $('#btn-deep-search');
        if (el) el.textContent = `正在检索 ${done}/${total}`;
      },
      shouldStop: () => token !== searchToken,
    });
    if (token !== searchToken) return;
    const all = store.searchLocal(q);
    renderSearch(all, q, token, '<div class="search-more"><div>已包含仓库中的全部历史</div></div>');
    if (hits.length) toast(`仓库里又找到 ${hits.length} 条`);
  } catch (e) {
    toast(`检索失败：${e.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '重试'; }
  }
}

/* ==================== 设置 ==================== */

function wireSettings() {
  $$('#settings [data-close]').forEach((b) => b.addEventListener('click', closeSettings));
}

async function openSettings() {
  els.settings.hidden = false;
  if (els.settingsBody) els.settingsBody.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  layerOpened('settings', hideSettings);
  await renderSettings();
}

function closeSettings() {
  if (!layerClose()) hideSettings();
}

function hideSettings() {
  els.settings.hidden = true;
  document.body.style.overflow = '';
}

async function renderSettings() {
  const cfg = store.config || {};
  const range = store.cacheRange();
  const mediaBytes = await store.storageBytes();
  const est = await storageEstimate();
  const pending = store.pendingCount();
  const missing = store.missingCount();
  const threeMonthsAgo = new Date(Date.now() - 90 * 86400000);

  const body = els.settingsBody;
  body.innerHTML = `
    <div class="set-group">
      <div class="set-group-title">仓库</div>
      <div class="set-row"><span class="k">地址</span><span class="v">${esc(cfg.owner || '')}/${esc(cfg.repo || '')}</span></div>
      <div class="set-row"><span class="k">分支</span><span class="v">${esc(cfg.branch || 'main')}</span></div>
      <div class="set-row"><span class="k">令牌</span><span class="v">${cfg.token ? '已保存（仅本机）' : '未设置'}</span></div>
      <div class="set-actions">
        <button class="btn-ghost" id="set-edit-config">修改配置</button>
        <button class="btn-ghost" id="set-test">测试连接</button>
      </div>
    </div>

    <div class="set-group">
      <div class="set-group-title">同步</div>
      <div class="set-row"><span class="k">状态</span><span class="v">${syncLabel()}</span></div>
      <div class="set-row"><span class="k">待同步</span><span class="v">${pending} 条</span></div>
      <div class="set-row"><span class="k">仓库里尚未缓存</span><span class="v">${missing} 条</span></div>
      <div class="set-actions">
        <button class="btn-ghost" id="set-sync">立即同步</button>
        <button class="btn-ghost" id="set-pull">拉取全部历史</button>
      </div>
    </div>

    <div class="set-group">
      <div class="set-group-title">本地缓存</div>
      <div class="set-row"><span class="k">已缓存笔记</span><span class="v">${range ? range.count + ' 条' : '0 条'}</span></div>
      <div class="set-row"><span class="k">时间范围</span><span class="v">${range ? `${fmtDateShort(range.oldest)} — ${fmtDateShort(range.newest)}` : '—'}</span></div>
      <div class="set-row"><span class="k">媒体占用</span><span class="v">${fmtBytes(mediaBytes)}${est.quota ? ` / 可用 ${fmtBytes(est.quota)}` : ''}</span></div>
      <div class="set-actions" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;gap:8px;align-items:center">
          <input type="date" class="set-input" id="set-cutoff" value="${fmtDateShort(threeMonthsAgo)}" style="margin:0;flex:1">
          <button class="btn-ghost btn-danger-ghost" id="set-clear" style="flex:0 0 auto">清理此前</button>
        </div>
      </div>
      <div class="set-hint">清理只是删掉手机上的副本，仓库里的还在。往下翻页时会自动把更早的笔记和媒体再拉回来。</div>
    </div>

    <div class="set-group">
      <div class="set-group-title">其他</div>
      <div class="set-actions">
        <button class="btn-ghost" id="set-refresh">检查更新</button>
        <button class="btn-ghost btn-danger-ghost" id="set-wipe">清空本地缓存</button>
      </div>
      <div class="set-hint">「检查更新」只重装界面文件并重载，笔记和令牌不受影响；「清空本地缓存」删掉手机上的笔记副本，往下翻页会重新从 GitHub 拉取。两个都不会动仓库。</div>
      <div class="set-row" style="margin-top:14px"><span class="k">版本</span><span class="v">${APP_VERSION} · PWA</span></div>
      <div class="set-row"><span class="k">数据位置</span><span class="v">github.com/${esc(cfg.owner || '')}/${esc(cfg.repo || '')}</span></div>
    </div>`;

  $('#set-edit-config').addEventListener('click', () => { closeSettings(); openSetup(true); });
  $('#set-test').addEventListener('click', async () => {
    try {
      const info = await store.gh.verify();
      toast(`连接正常：${info.fullName}（${info.isPrivate ? '私有' : '公开'}）`);
    } catch (e) { toast(`连接失败：${e.message}`); }
  });
  $('#set-sync').addEventListener('click', async () => {
    toast('同步中…');
    await store.refreshTree({ quiet: true }).catch(() => {});
    await store.flushQueue();
    await renderSettings();
    toast('同步完成');
  });
  $('#set-pull').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '拉取中…';
    try {
      const n = await store.pullAll({ onProgress: (d, t) => { btn.textContent = `${d}/${t}`; } });
      toast(`已拉取 ${n} 条`);
    } catch (err) {
      toast(`失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '拉取全部历史';
      renderSettings();
    }
  });
  $('#set-clear').addEventListener('click', async () => {
    const cutoff = $('#set-cutoff').value;
    if (!cutoff) return;
    const count = store.notes.filter((n) => n.id.slice(0, 8) < cutoff.replace(/-/g, '')).length;
    if (!count) return toast('这个日期之前没有本地数据');
    if (!window.confirm(`将清理 ${cutoff} 之前的 ${count} 条本地副本，仓库里的数据不动。继续？`)) return;
    const r = await store.clearBefore(cutoff);
    toast(`已清理 ${r.count} 条，释放 ${fmtBytes(r.bytes)}`);
    renderSettings();
    renderFeed();
  });
  $('#set-wipe').addEventListener('click', async () => {
    if (!window.confirm('清空手机上缓存的所有笔记与媒体文件？仓库里的数据不受影响。')) return;
    await dbNotes.clear();
    await dbBlobs.clear();
    store.notes = [];
    renderFeed();
    renderSettings();
    toast('本地缓存已清空');
  });
  $('#set-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '刷新中…';
    try {
      const reg = navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null;
      if (reg) await reg.update().catch(() => {});
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('notestream-shell-')).map((k) => caches.delete(k)));
    } catch (err) {
      console.warn('refresh failed', err);
    }
    location.reload();
  });
}

function syncLabel() {
  if (!navigator.onLine) return '离线';
  if (store.syncState === 'syncing') return '同步中…';
  if (store.syncState === 'error') return store.syncMessage || '同步失败';
  return '正常';
}

/* ==================== 首次配置 ==================== */

export function openSetup(editing = false) {
  const setup = $('#setup');
  setup.hidden = false;
  els.app.hidden = true;
  if (editing) {
    // 从设置里进来的「修改配置」：返回键应该退回应用，而不是直接退出
    layerOpened('setup', () => {
      setup.hidden = true;
      els.app.hidden = false;
      document.body.style.overflow = '';
    });
  }
  const cfg = store.config || {};
  $('#setup-owner').value = cfg.owner || '';
  $('#setup-repo').value = cfg.repo || '';
  $('#setup-token').value = cfg.token || '';
  $('#setup-branch').value = cfg.branch || 'main';

  const btn = $('#btn-setup-save');
  btn.textContent = editing ? '保存并重新连接' : '连接并开始';
  btn.onclick = async () => {
    const owner = $('#setup-owner').value.trim();
    const repo = $('#setup-repo').value.trim();
    const token = $('#setup-token').value.trim();
    const branch = $('#setup-branch').value.trim() || 'main';
    const hint = $('#setup-hint');
    if (!owner || !repo || !token) {
      hint.textContent = '仓库和令牌都要填。';
      hint.style.color = 'var(--danger)';
      return;
    }
    btn.disabled = true;
    btn.textContent = '连接中…';
    try {
      const { GitHubClient } = await import('./gh.js');
      const gh = new GitHubClient({ owner, repo, branch, token });
      const info = await gh.verify();
      if (info.isPrivate) toast('提示：仓库是私有的，图片在网页端将无法匿名访问');

      const changed = store.config && (store.config.owner !== owner || store.config.repo !== repo || store.config.branch !== branch);
      if (changed) {
        // 换了仓库 → 本地缓存作废，避免把两边的数据混在一起
        await dbNotes.clear();
        await dbBlobs.clear();
        store.notes = [];
        store.remote = { paths: [], fetchedAt: 0 };
        store.tombs.clear();
      }

      await store.saveConfig({ owner, repo, branch, token });
      layerForget('setup');
      setup.hidden = true;
      els.app.hidden = false;
      await store.init();
      renderFeed();
      toast(`已连接 ${info.fullName}`);
    } catch (e) {
      hint.textContent = e.message || '连接失败';
      hint.style.color = 'var(--danger)';
    } finally {
      btn.disabled = false;
      btn.textContent = editing ? '保存并重新连接' : '连接并开始';
    }
  };

  $('#btn-setup-help').onclick = () => {
    const h = $('#setup-help');
    h.hidden = !h.hidden;
  };
}

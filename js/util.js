// ===== 通用工具 =====

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const pad = (n) => String(n).padStart(2, '0');

/** 生成可排序的笔记 id：20261108T123045-7f3a */
export function makeId(d = new Date()) {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

/** 从 id 里解析出时间（本地时间） */
export function idToDate(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(id || '');
  if (!m) return new Date(0);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** 本地时间的 ISO 串（带时区偏移），形如 2026-11-08T12:30:45+08:00 */
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`;
}

export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function fmtTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDayLabel(d) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff === 2) return '前天';
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}年${md}`;
  return `${md} ${wd}`;
}

export function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${pad(m)}:${pad(s)}`;
}

export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export function fmtDateShort(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 文本转义 + 自动识别链接 + 关键词高亮 */
export function renderText(text, keyword) {
  let html = esc(text);
  html = html.replace(/(https?:\/\/[^\s<>"）)]+)/g, (m) => {
    const short = m.replace(/^https?:\/\//, '');
    const label = short.length > 42 ? short.slice(0, 40) + '…' : short;
    return `<a href="${m}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  if (keyword && keyword.trim()) {
    const k = keyword.trim();
    const re = new RegExp(escapeReg(k), 'gi');
    html = html.replace(re, (m) => (m.includes('<') ? m : `<mark>${m}</mark>`));
  }
  return html;
}

export function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 限制并发的批量执行 */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function bufToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function utf8ToBase64(str) {
  return bufToBase64(new TextEncoder().encode(str));
}

export function base64ToBuf(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

export function haptic(ms = 8) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

/** 从文件名/URI 猜扩展名 */
export function extFromMime(mime) {
  const map = {
    'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/heic': 'heic', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg', 'audio/mp4a-latm': 'm4a', 'audio/aac': 'aac',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  };
  return map[mime] || (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '');
}

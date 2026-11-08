// ===== 状态与同步引擎 =====
// 设计要点：
//   1. GitHub 仓库是唯一事实来源，本地 IndexedDB 只是缓存 + 待推送队列
//   2. 笔记一条一个 Markdown 文件：notes/YYYY/MM/<id>.md
//   3. 媒体一条一个文件：media/YYYY/MM/<id>/<k>.<ext>
//   4. 本地可按日期清理；翻页时按需从仓库回捞被清掉的笔记

import { notes as dbNotes, blobs as dbBlobs, meta as dbMeta } from './db.js';
import { GitHubClient, GHError } from './gh.js';
import {
  makeId, idToDate, isoLocal, mapLimit, pad, extFromMime, dayKey,
} from './util.js';

const NOTE_PATH_RE = /^notes\/\d{4}\/\d{2}\/[^/]+\.md$/;
const PAGE_SIZE = 15;
const DEEP_SEARCH_LIMIT = 600;

export const store = {
  config: null,
  gh: null,
  notes: [],            // 按 id 倒序
  remote: { paths: [], shas: {}, fetchedAt: 0 },  // 远端所有笔记路径（倒序）+ 每个文件的 sha
  tombs: new Set(),
  loaded: false,
  syncState: 'idle',    // idle | syncing | error
  syncMessage: '',
  lastError: null,
  listeners: new Set(),

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit(type = 'change', data = null) {
    for (const fn of this.listeners) {
      try { fn(type, data); } catch (e) { console.error(e); }
    }
  },

  /* ==================== 配置 ==================== */

  async loadConfig() {
    const cfg = await dbMeta.get('config', null);
    this.config = cfg;
    this.tombs = new Set(await dbMeta.get('tombs', []));
    const tree = await dbMeta.get('remoteTree', null);
    if (tree) this.remote = tree;
    if (cfg && cfg.owner && cfg.repo && cfg.token) {
      this.gh = new GitHubClient(cfg);
    }
    return cfg;
  },

  async saveConfig(cfg) {
    this.config = cfg;
    await dbMeta.set('config', cfg);
    this.gh = new GitHubClient(cfg);
    this.emit('config');
  },

  hasConfig() {
    return !!(this.config && this.config.owner && this.config.repo && this.config.token);
  },

  /* ==================== 启动 ==================== */

  async init() {
    await this.loadConfig();
    if (!this.hasConfig()) { this.loaded = true; return; }
    const list = await dbNotes.all();
    this.notes = list.sort((a, b) => (a.id < b.id ? 1 : -1));
    this.loaded = true;
    this.emit('load');
    // 后台刷新远端文件树；顺便把别的设备新写/改过的笔记拉回来
    this.refreshTree({ quiet: true })
      .then(async () => {
        if (!this.notes.length && this.remote.paths.length) {
          await this.loadOlder(PAGE_SIZE);
        } else {
          await this.pullRemote().catch(() => {});
        }
      })
      .catch(() => {});
    this.flushQueue().catch(() => {});
  },

  /* ==================== 笔记路径 ==================== */

  notePath(id) {
    return `notes/${id.slice(0, 4)}/${id.slice(4, 6)}/${id}.md`;
  },

  mediaPath(id, k, mime) {
    return `media/${id.slice(0, 4)}/${id.slice(4, 6)}/${id}/${k}.${extFromMime(mime)}`;
  },

  blobKey(id, k) { return `${id}:${k}`; },

  /* ==================== Markdown 编解码 ==================== */

  toMarkdown(note) {
    const media = note.media.map((m) => ({
      k: m.k, t: m.t, p: m.p, m: m.m, w: m.w || 0, h: m.h || 0, dur: Math.round(m.dur || 0),
    }));
    const lines = ['---', `id: ${note.id}`, `created: ${note.created}`, `updated: ${note.updated}`];
    if (media.length) lines.push(`media: ${JSON.stringify(media)}`);
    lines.push('---');
    return `${lines.join('\n')}\n${note.text || ''}\n`;
  },

  fromMarkdown(raw, { path = '' } = {}) {
    let text = raw.replace(/\r\n/g, '\n');
    const out = { id: '', created: '', updated: '', media: [], text: '', pending: false, remote: true, up: true };

    if (text.startsWith('---\n')) {
      const end = text.indexOf('\n---', 3);
      if (end > 0) {
        const fm = text.slice(4, end);
        text = text.slice(end + 4).replace(/^\n/, '');
        for (const line of fm.split('\n')) {
          const idx = line.indexOf(':');
          if (idx < 0) continue;
          const key = line.slice(0, idx).trim();
          const val = line.slice(idx + 1).trim();
          if (key === 'media') {
            try { out.media = JSON.parse(val).map((m) => ({ ...m, up: true })); } catch { out.media = []; }
          } else {
            out[key] = val;
          }
        }
      }
    }

    out.text = text.replace(/\n+$/, '');
    if (!out.id) {
      const m = /\/([^/]+)\.md$/.exec(path);
      out.id = m ? m[1] : '';
    }
    if (out.id && !out.created) out.created = isoLocal(idToDate(out.id));
    if (!out.updated) out.updated = out.created;
    if (!out.id) return null;
    return out;
  },

  /* ==================== 新增 / 修改 ==================== */

  buildNote({ id, created, text, media }) {
    const now = new Date();
    const nid = id || makeId(now);
    const mediaList = (media || []).map((m) => ({
      ...m,
      p: m.p || this.mediaPath(nid, m.k, m.m),
    }));
    return {
      id: nid,
      created: created || isoLocal(idToDate(nid)),
      updated: isoLocal(now),
      text: text || '',
      media: mediaList,
      pending: true,
      remote: false,
      up: false,
      pushError: null,
    };
  },

  async addNote({ text, media = [], blobs = [] }) {
    const note = this.buildNote({ text, media });
    await this.persistBlobs(note.id, blobs);
    await this.persistNote(note);
    this.insertLocal(note);
    this.emit('add', note);
    this.flushQueue().catch(() => {});
    return note;
  },

  async updateNote(id, { text, media, blobs = [] }) {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return null;
    const oldMedia = note.media || [];
    note.text = text;
    note.media = (media || note.media).map((m) => ({ ...m, p: m.p || this.mediaPath(id, m.k, m.m) }));
    note.updated = isoLocal(new Date());
    note.pending = true;
    note.pushError = null;
    await this.persistBlobs(id, blobs);
    await this.persistNote(note);

    // 被移除的媒体：本地删缓存，远端删文件
    const keep = new Set(note.media.map((m) => m.k));
    for (const m of oldMedia) {
      if (keep.has(m.k)) continue;
      await dbBlobs.deleteMany([this.blobKey(id, m.k)]);
      if (m.p && this.gh) {
        this.gh.deleteFile(m.p, `delete media: ${id} ${m.k}`).catch(() => {});
      }
    }

    this.emit('update', note);
    this.flushQueue().catch(() => {});
    return note;
  },

  async persistBlobs(noteId, blobList) {
    for (const { k, blob } of blobList || []) {
      if (blob) await dbBlobs.put(this.blobKey(noteId, k), blob, blob.type || 'application/octet-stream');
    }
  },

  async persistNote(note) {
    const clean = { ...note };
    delete clean.blob;
    await dbNotes.put(clean);
  },

  insertLocal(note) {
    const idx = this.notes.findIndex((n) => n.id === note.id);
    if (idx >= 0) this.notes[idx] = note;
    else {
      this.notes.push(note);
      this.notes.sort((a, b) => (a.id < b.id ? 1 : -1));
    }
  },

  /* ==================== 推送队列 ==================== */

  _chain: Promise.resolve(),

  flushQueue() {
    this._chain = this._chain.then(() => this._flushOnce()).catch(() => {});
    return this._chain;
  },

  async _flushOnce() {
    if (!this.gh) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const pending = this.notes.filter((n) => n.pending || n.deletingPending);
    if (!pending.length) {
      if (this.syncState !== 'idle') { this.syncState = 'idle'; this.syncMessage = ''; this.emit('sync'); }
      return;
    }
    this.syncState = 'syncing';
    this.emit('sync');
    for (const note of pending) {
      let removed = false;
      try {
        if (note.deletingPending) {
          await this._deleteRemote(note);
          await this.removeLocal(note);
          removed = true;
        } else {
          await this._pushOne(note);
        }
        note.pushError = null;
      } catch (e) {
        console.warn('push failed', note.id, e);
        note.pushError = e.message || '同步失败';
        this.lastError = e;
      }
      if (!removed) await this.persistNote(note);
      this.emit('sync');
    }
    const stillPending = this.notes.some((n) => n.pending || n.deletingPending);
    this.syncState = stillPending ? 'error' : 'idle';
    this.syncMessage = stillPending ? (this.notes.find((n) => n.pushError)?.pushError || '') : '';
    this.emit('sync');
    if (!stillPending) this.emit('change');
  },

  async _pushOne(note) {
    // 1. 先传媒体（幂等：路径确定）
    for (const m of note.media) {
      if (m.up) continue;
      const rec = await dbBlobs.get(this.blobKey(note.id, m.k));
      if (!rec) { m.up = true; continue; } // 本地已无二进制，无法再上传
      const bytes = new Uint8Array(await rec.blob.arrayBuffer());
      await this.gh.putFile(m.p, bytes, `media: ${note.id} ${m.k}`, { binary: true });
      m.up = true;
      await this.persistNote(note);
    }
    // 2. 再写笔记本体
    const md = this.toMarkdown(note);
    const res = await this.gh.putFile(this.notePath(note.id), md, `note: ${note.id}`);
    note.pending = false;
    note.remote = true;
    // 记下这次的 sha，下次同步时才能分辨「远端被人改过」和「就是我自己刚写的」
    note.sha = (res && res.sha) || null;
    const path = this.notePath(note.id);
    if (!this.remote.paths.includes(path)) {
      this.remote.paths.push(path);
      this.remote.paths.sort(descByPath);
    }
    if (note.sha) this.remote.shas = { ...this.remote.shas, [path]: note.sha };
    dbMeta.set('remoteTree', this.remote).catch(() => {});
  },

  /* ==================== 远端文件树 ==================== */

  async refreshTree({ quiet = false } = {}) {
    if (!this.gh) return [];
    if (!quiet) { this.syncState = 'syncing'; this.emit('sync'); }
    try {
      const { files } = await this.gh.tree();
      const shas = {};
      for (const f of files) {
        if (NOTE_PATH_RE.test(f.path)) shas[f.path] = f.sha;
      }
      const paths = files
        .filter((f) => NOTE_PATH_RE.test(f.path))
        .map((f) => f.path)
        .filter((p) => !this.tombs.has(idFromPath(p)))
        .sort(descByPath);
      this.remote = { paths, shas, fetchedAt: Date.now() };
      await dbMeta.set('remoteTree', this.remote);
      if (!quiet) { this.syncState = 'idle'; this.emit('sync'); }
      this.emit('remote');
      return paths;
    } catch (e) {
      if (e.status === 404) {
        // 空仓库，还没有任何提交
        this.remote = { paths: [], shas: {}, fetchedAt: Date.now() };
        return [];
      }
      this.syncState = 'error';
      this.syncMessage = e.message || '读取仓库失败';
      this.lastError = e;
      if (!quiet) this.emit('sync');
      throw e;
    }
  },

  remoteIds() {
    return this.remote.paths.map(idFromPath);
  },

  /** 远端比本地多的笔记数量 */
  missingCount() {
    const local = new Set(this.notes.map((n) => n.id));
    return this.remote.paths.filter((p) => !local.has(idFromPath(p))).length;
  },

  /* ==================== 翻页回捞 ==================== */

  async loadOlder(count = PAGE_SIZE, { onProgress } = {}) {
    if (!this.gh) return 0;
    if (!this.remote.paths.length) {
      await this.refreshTree({ quiet: true }).catch(() => {});
    }
    const local = new Set(this.notes.map((n) => n.id));
    const oldestLocalId = this.notes.length ? this.notes[this.notes.length - 1].id : null;

    let candidates = this.remote.paths.filter((p) => {
      const id = idFromPath(p);
      if (local.has(id)) return false;
      if (this.tombs.has(id)) return false;
      if (oldestLocalId && id >= oldestLocalId) return false;
      return true;
    });
    candidates = candidates.slice(0, count);
    if (!candidates.length) return 0;

    let done = 0;
    const fetched = [];
    const shas = this.remote.shas || {};
    await mapLimit(candidates, 3, async (p) => {
      try {
        const raw = await this.gh.getText(p);
        const parsed = this.fromMarkdown(raw, { path: p });
        if (parsed) {
          parsed.sha = shas[p] || null;   // 记住远端版本，之后才能识别「别处改过」
          fetched.push(parsed);
        }
      } catch (e) {
        console.warn('fetch note failed', p, e);
      } finally {
        done++;
        onProgress && onProgress(done, candidates.length);
      }
    });

    let uploadedBlobs = 0;
    fetched.sort((a, b) => (a.id < b.id ? 1 : -1));
    await dbNotes.putMany(fetched);
    for (const n of fetched) {
      if (!this.notes.some((x) => x.id === n.id)) this.notes.push(n);
    }
    this.notes.sort((a, b) => (a.id < b.id ? 1 : -1));
    this.emit('change');
    return fetched.length;
  },

  /**
   * 补齐远端比本地多出来的内容：
   *   1. 别的设备新写的笔记（比本地最新的还新）
   *   2. 别的设备改过的笔记（远端 sha 与本地记录的不一致，且本地没有待推送的改动）
   * 更早的笔记仍然交给翻页 loadOlder 处理。
   */
  async pullRemote({ limit = 50 } = {}) {
    if (!this.gh) return { added: 0, changed: 0 };
    if (!this.remote.paths.length || Date.now() - (this.remote.fetchedAt || 0) > 30_000) {
      await this.refreshTree({ quiet: true }).catch(() => {});
    }
    const shas = this.remote.shas || {};
    const byId = new Map(this.notes.map((n) => [n.id, n]));
    const newestLocalId = this.notes.length ? this.notes[0].id : null;

    const added = [];
    const changed = [];
    for (const p of this.remote.paths) {
      const id = idFromPath(p);
      if (this.tombs.has(id)) continue;
      const local = byId.get(id);
      if (!local) {
        if (!newestLocalId || id > newestLocalId) added.push(p);
        continue;
      }
      if (local.pending) continue;                        // 本地有没推上去的改动，别被覆盖
      const remoteSha = shas[p];
      if (local.sha && remoteSha && local.sha !== remoteSha) changed.push(p);
    }

    const todo = added.slice(0, limit).concat(changed.slice(0, limit));
    if (!todo.length) return { added: 0, changed: 0 };

    const fetched = [];
    await mapLimit(todo, 3, async (p) => {
      try {
        const raw = await this.gh.getText(p);
        const note = this.fromMarkdown(raw, { path: p });
        if (!note) return;
        note.sha = shas[p] || null;
        note.remote = true;
        note.pending = false;
        note.pushError = null;
        fetched.push(note);
      } catch (e) {
        console.warn('pull note failed', p, e);
      }
    });
    if (!fetched.length) return { added: 0, changed: 0 };

    await dbNotes.putMany(fetched);
    let nAdded = 0;
    let nChanged = 0;
    for (const note of fetched) {
      if (byId.has(note.id)) nChanged++;
      else nAdded++;
      this.insertLocal(note);
    }
    this.notes.sort((a, b) => (a.id < b.id ? 1 : -1));
    this.emit('change');
    return { added: nAdded, changed: nChanged };
  },

  /** 拉取全部远端笔记（不含媒体二进制） */
  async pullAll({ onProgress } = {}) {
    await this.refreshTree({ quiet: true });
    let total = 0;
    // 分批，避免一次请求过多
    for (let i = 0; i < 100; i++) {
      const n = await this.loadOlder(25, { onProgress });
      total += n;
      if (n === 0) break;
    }
    return total;
  },

  /* ==================== 媒体读写 ==================== */

  async getBlob(noteId, k) {
    const rec = await dbBlobs.get(this.blobKey(noteId, k));
    return rec ? rec.blob : null;
  },

  async putBlob(noteId, k, blob) {
    await dbBlobs.put(this.blobKey(noteId, k), blob, blob.type);
  },

  async deleteBlob(noteId, k) {
    await dbBlobs.deleteMany([this.blobKey(noteId, k)]);
  },

  /** 从仓库回捞单个媒体文件并缓存 */
  async fetchMedia(noteId, media) {
    if (!this.gh || !media.p) return null;
    const existing = await this.getBlob(noteId, media.k);
    if (existing) return existing;
    try {
      const res = await fetch(this.gh.rawUrl(media.p), { cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      await this.putBlob(noteId, media.k, blob);
      return blob;
    } catch (e) {
      console.warn('media fetch failed', media.p, e);
      return null;
    }
  },

  /* ==================== 删除 ==================== */

  async deleteNote(id) {
    const note = this.notes.find((n) => n.id === id);
    if (!note) return;
    if (!note.remote) {
      // 从未推送成功，直接本地抹掉
      await this.removeLocal(note);
      this.emit('change');
      return;
    }
    note.deletingPending = true;
    note.pending = false;
    await this.persistNote(note);
    this.emit('sync');
    try {
      await this._deleteRemote(note);
    } catch (e) {
      note.pushError = e.message;
      this.syncState = 'error';
      this.emit('sync');
      throw e;
    }
    await this.removeLocal(note);
    this.emit('change');
  },

  async _deleteRemote(note) {
    const notePath = this.notePath(note.id);
    await this.gh.deleteFile(notePath, `delete note: ${note.id}`);
    for (const m of note.media) {
      if (!m.p) continue;
      try { await this.gh.deleteFile(m.p, `delete media: ${note.id} ${m.k}`); } catch (e) { console.warn(e); }
    }
    // 墓碑：避免刷新文件树后又把它拉回来
    this.tombs.add(note.id);
    await dbMeta.set('tombs', Array.from(this.tombs).slice(-2000));
    this.remote.paths = this.remote.paths.filter((p) => idFromPath(p) !== note.id);
    dbMeta.set('remoteTree', this.remote).catch(() => {});
    note.deletingPending = false;
    note.pending = false;
    note.remote = false;
  },

  async removeLocal(note) {
    await dbNotes.deleteMany([note.id]);
    await dbBlobs.deleteMany(note.media.map((m) => this.blobKey(note.id, m.k)));
    this.notes = this.notes.filter((n) => n.id !== note.id);
  },

  /* ==================== 按日期清理 ==================== */

  /** 清理 dateStr（YYYY-MM-DD）之前创建的本地数据 */
  async clearBefore(dateStr) {
    const cut = dateStr.replace(/-/g, '');
    const victims = this.notes.filter((n) => n.id.slice(0, 8) < cut);
    if (!victims.length) return { count: 0, bytes: 0 };
    let bytes = 0;
    const blobKeys = [];
    for (const n of victims) {
      for (const m of n.media) {
        const rec = await dbBlobs.get(this.blobKey(n.id, m.k));
        if (rec) bytes += rec.size || 0;
        blobKeys.push(this.blobKey(n.id, m.k));
      }
    }
    await dbNotes.deleteMany(victims.map((n) => n.id));
    await dbBlobs.deleteMany(blobKeys);
    const ids = new Set(victims.map((n) => n.id));
    this.notes = this.notes.filter((n) => !ids.has(n.id));
    await dbMeta.set('cacheFloor', dateStr);
    this.emit('change');
    return { count: victims.length, bytes };
  },

  /** 本地缓存覆盖范围 */
  cacheRange() {
    if (!this.notes.length) return null;
    const oldest = this.notes[this.notes.length - 1];
    const newest = this.notes[0];
    return { oldest: idToDate(oldest.id), newest: idToDate(newest.id), count: this.notes.length };
  },

  /* ==================== 搜索 ==================== */

  searchLocal(q) {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    return this.notes.filter((n) => {
      if ((n.text || '').toLowerCase().includes(k)) return true;
      const d = idToDate(n.id);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`.includes(k);
    });
  },

  /** 把还没缓存的远端笔记拉下来做全文匹配（内容会顺带缓存） */
  async searchRemote(q, { onProgress, shouldStop } = {}) {
    if (!this.gh) return [];
    const k = q.trim().toLowerCase();
    if (!k) return [];
    if (!this.remote.paths.length) await this.refreshTree({ quiet: true });
    const local = new Set(this.notes.map((n) => n.id));
    const paths = this.remote.paths
      .filter((p) => !local.has(idFromPath(p)) && !this.tombs.has(idFromPath(p)))
      .slice(0, DEEP_SEARCH_LIMIT);

    const hits = [];
    const fetched = [];
    let done = 0;
    await mapLimit(paths, 4, async (p) => {
      if (shouldStop && shouldStop()) return;
      try {
        const raw = await this.gh.getText(p);
        const note = this.fromMarkdown(raw, { path: p });
        if (!note) return;
        fetched.push(note);
        if ((note.text || '').toLowerCase().includes(k)) hits.push(note);
      } catch { /* skip */ } finally {
        done++;
        onProgress && onProgress(done, paths.length);
      }
    });

    // 顺手把这些笔记也缓存下来，下次不用再翻仓库
    if (fetched.length) {
      await dbNotes.putMany(fetched);
      const known = new Set(this.notes.map((n) => n.id));
      for (const n of fetched) if (!known.has(n.id)) this.notes.push(n);
      this.notes.sort((a, b) => (a.id < b.id ? 1 : -1));
    }
    this.emit('change');
    return hits;
  },

  /* ==================== 统计 ==================== */

  pendingCount() {
    return this.notes.filter((n) => n.pending || n.deletingPending).length;
  },

  async storageBytes() {
    return dbBlobs.usageBytes();
  },
};

function idFromPath(p) {
  const m = /\/([^/]+)\.md$/.exec(p);
  return m ? m[1] : p;
}

function descByPath(a, b) {
  const ia = idFromPath(a);
  const ib = idFromPath(b);
  return ia < ib ? 1 : ia > ib ? -1 : 0;
}

export { dayKey, GHError };

// ===== 本地数据库（IndexedDB） =====
// notes : 笔记元数据与正文
// blobs : 媒体二进制（key = 媒体在笔记里的局部 key）
// meta  : 配置、远端文件树缓存、墓碑（已删除 id）

const DB_NAME = 'note-stream';
const DB_VER = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) {
        const s = db.createObjectStore('notes', { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeNames, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    try {
      const stores = storeNames.map((n) => tx.objectStore(n));
      const maybe = fn(...stores);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then((v) => { result = v; }).catch(reject);
      } else {
        result = maybe;
      }
    } catch (e) {
      reject(e);
    }
  }));
}

/* ---------------- notes ---------------- */

export const notes = {
  put(note) {
    return run(['notes'], 'readwrite', (s) => { s.put(note); });
  },
  async putMany(list) {
    if (!list.length) return;
    return run(['notes'], 'readwrite', (s) => { list.forEach((n) => s.put(n)); });
  },
  get(id) {
    return run(['notes'], 'readonly', (s) => req(s.get(id)));
  },
  all() {
    return run(['notes'], 'readonly', (s) => req(s.getAll()));
  },
  async deleteMany(ids) {
    if (!ids.length) return;
    return run(['notes'], 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); });
  },
  clear() {
    return run(['notes'], 'readwrite', (s) => { s.clear(); });
  },
  count() {
    return run(['notes'], 'readonly', (s) => req(s.count()));
  },
};

/* ---------------- blobs ---------------- */

export const blobs = {
  put(key, blob, mime) {
    return run(['blobs'], 'readwrite', (s) => { s.put({ key, blob, mime, size: blob.size }); });
  },
  async putMany(items) {
    if (!items.length) return;
    return run(['blobs'], 'readwrite', (s) => { items.forEach((it) => s.put(it)); });
  },
  get(key) {
    return run(['blobs'], 'readonly', (s) => req(s.get(key)));
  },
  deleteMany(keys) {
    if (!keys.length) return Promise.resolve();
    return run(['blobs'], 'readwrite', (s) => { keys.forEach((k) => s.delete(k)); });
  },
  keys() {
    return run(['blobs'], 'readonly', (s) => req(s.getAllKeys()));
  },
  clear() {
    return run(['blobs'], 'readwrite', (s) => { s.clear(); });
  },
  async usageBytes() {
    const all = await run(['blobs'], 'readonly', (s) => req(s.getAll()));
    return all.reduce((a, b) => a + (b.size || 0), 0);
  },
};

/* ---------------- meta ---------------- */

export const meta = {
  async get(k, dflt = null) {
    const row = await run(['meta'], 'readonly', (s) => req(s.get(k)));
    return row ? row.v : dflt;
  },
  set(k, v) {
    return run(['meta'], 'readwrite', (s) => { s.put({ k, v }); });
  },
  del(k) {
    return run(['meta'], 'readwrite', (s) => { s.delete(k); });
  },
  async bumpPrefix(prefix) {
    // 用于墓碑集合等：读出 → 调用方改写 → 写回
    return meta.get(prefix, null);
  },
};

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 请求持久化存储，尽量避免被系统回收 */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch { /* ignore */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0 };
    }
  } catch { /* ignore */ }
  return { usage: 0, quota: 0 };
}

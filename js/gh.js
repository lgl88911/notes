// ===== GitHub API 客户端 =====
// 只做一件事：把文件可靠地读写进一个公开仓库。

import { bufToBase64, utf8ToBase64, base64ToBuf } from './util.js';

export class GHError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'GHError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export class GitHubClient {
  constructor({ owner, repo, branch = 'main', token }) {
    this.owner = (owner || '').trim();
    this.repo = (repo || '').trim();
    this.branch = (branch || 'main').trim();
    this.token = (token || '').trim();
    this.lastRate = null;
  }

  get apiBase() { return 'https://api.github.com'; }
  get repoPath() { return `/repos/${this.owner}/${this.repo}`; }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(this.branch)}/${encPath(path)}`;
  }

  pagesUrl(path) {
    return `https://${this.owner}.github.io/${this.repo}/${encPath(path)}`;
  }

  async request(path, { method = 'GET', body, accept = 'application/vnd.github+json', raw = false } = {}) {
    const url = path.startsWith('http') ? path : this.apiBase + path;
    const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (e) {
      throw new GHError(0, '网络不可用，请检查连接');
    }

    const rl = res.headers.get('x-ratelimit-remaining');
    if (rl !== null) {
      this.lastRate = {
        remaining: Number(rl),
        limit: Number(res.headers.get('x-ratelimit-limit') || 0),
        reset: Number(res.headers.get('x-ratelimit-reset') || 0) * 1000,
      };
    }

    if (!res.ok) {
      let msg = `GitHub 返回 ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.message) msg = j.message;
        if (res.status === 401) msg = '令牌无效或已过期';
        if (res.status === 403 && /rate limit/i.test(msg)) msg = 'GitHub API 调用超限，请稍后再试';
        if (res.status === 404) msg = '仓库或文件不存在（检查用户名、仓库名、分支和令牌权限）';
        if (res.status === 409 && /empty/i.test(msg)) msg = '仓库还是空的，先在 GitHub 上建一次 README 或推送一次代码';
        if (res.status === 413) msg = '文件太大，GitHub 拒绝了这次上传';
      } catch { /* not json */ }
      throw new GHError(res.status, msg, { remaining: this.lastRate?.remaining });
    }

    if (res.status === 204) return null;
    if (raw) return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  /* ---------- 仓库 ---------- */

  getRepo() {
    return this.request(this.repoPath);
  }

  getViewer() {
    return this.request('/user');
  }

  async verify() {
    const repo = await this.getRepo();
    if (!repo || !repo.full_name) throw new GHError(0, '无法读取仓库信息');
    return {
      fullName: repo.full_name,
      isPrivate: repo.private,
      defaultBranch: repo.default_branch,
      sizeKb: repo.size,
    };
  }

  /* ---------- 文件树 ---------- */

  /**
   * 列出分支下所有文件（一次请求）。
   * 返回 [{ path, sha, size }]
   */
  async tree() {
    const data = await this.request(`${this.repoPath}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`);
    if (!data || !Array.isArray(data.tree)) return { files: [], truncated: false };
    const files = data.tree
      .filter((n) => n.type === 'blob')
      .map((n) => ({ path: n.path, sha: n.sha, size: n.size || 0 }));
    return { files, truncated: !!data.truncated };
  }

  /* ---------- 单文件读写 ---------- */

  /** 读取文件内容为文本 */
  async getText(path) {
    const bytes = await this.request(`${this.repoPath}/contents/${encPath(path)}?ref=${encodeURIComponent(this.branch)}`, {
      accept: 'application/vnd.github.raw',
      raw: true,
    });
    return new TextDecoder().decode(bytes);
  }

  /** 读取文件内容为二进制 */
  async getBytes(path) {
    return this.request(`${this.repoPath}/contents/${encPath(path)}?ref=${encodeURIComponent(this.branch)}`, {
      accept: 'application/vnd.github.raw',
      raw: true,
    });
  }

  async getMeta(path) {
    try {
      const data = await this.request(`${this.repoPath}/contents/${encPath(path)}?ref=${encodeURIComponent(this.branch)}`);
      if (Array.isArray(data)) return null;
      return data ? { sha: data.sha, size: data.size } : null;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  /**
   * 写入（新建或覆盖）一个文件。
   * content: string（文本）或 Uint8Array（二进制）
   */
  async putFile(path, content, message, { binary = false, sha = null } = {}) {
    const b64 = binary ? bufToBase64(content) : utf8ToBase64(content);
    const body = { message, content: b64, branch: this.branch };
    if (sha) body.sha = sha;
    const url = `${this.repoPath}/contents/${encPath(path)}`;
    try {
      const res = await this.request(url, { method: 'PUT', body });
      return { sha: res?.content?.sha || null, commit: res?.commit?.sha || null, existed: false };
    } catch (e) {
      // 文件已存在但没带 sha → 取回 sha 再写
      if (e.status === 422 || e.status === 409) {
        const cur = await this.getMeta(path);
        if (cur && cur.sha !== sha) {
          body.sha = cur.sha;
          const res = await this.request(url, { method: 'PUT', body });
          return { sha: res?.content?.sha || null, commit: res?.commit?.sha || null, existed: true };
        }
      }
      throw e;
    }
  }

  /** 删除文件；文件本来就不存在时返回 false */
  async deleteFile(path, message) {
    const cur = await this.getMeta(path);
    if (!cur) return false;
    await this.request(`${this.repoPath}/contents/${encPath(path)}`, {
      method: 'DELETE',
      body: { message, sha: cur.sha, branch: this.branch },
    });
    return true;
  }

  /** 确认仓库可写（能读到分支头即可，不产生副作用） */
  async pingWrite() {
    try {
      await this.request(`${this.repoPath}/git/ref/heads/${encodeURIComponent(this.branch)}`);
      return true;
    } catch (e) {
      if (e.status === 404) {
        throw new GHError(404, `分支 ${this.branch} 不存在`);
      }
      if (e.status === 409 || e.status === 403) return true;
      throw e;
    }
  }
}

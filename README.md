# 随想 · note stream

一个用来记短笔记的手机 App。文字、图片、音频、视频都能记，所有数据存在你自己的 GitHub 公开仓库里，手机本地只是缓存。

形式参考 [qiaomu.ai/notes](https://www.qiaomu.ai/notes/)：倒序时间流，每条一个时间点，一条笔记一个文件。

## 它是怎么工作的

```
手机浏览器 (PWA)
├── IndexedDB     本地缓存 + 待推送队列 + 媒体二进制
└── GitHub API ──► 你的仓库（公开）
                    notes/2026/11/20261108T123045-7f3a.md
                    media/2026/11/20261108T123045-7f3a/m1.webp
```

- **仓库是唯一事实来源**。手机丢了、清了缓存、换了设备，重新填一遍仓库信息就能全部拉回来。
- **本地优先**。写完立刻落本地并上屏，网络恢复后自动推送；断网也能记。
- **一条笔记一个文件**。Git 历史里能看清楚每次改动，删除时只动对应那一个文件。
- **媒体同仓库**。图片上传前压成 WebP（长边 1600），音频用 opus 录音，视频限 25MB 以内。

## 部署

1. 建一个**公开**仓库（比如 `notes`）。
2. 把这个目录推到仓库根目录（`main` 分支）。
3. 仓库 Settings → Pages → Source 选 **GitHub Actions**（或直接用 `Deploy static content to Pages` 模板，仓库里已带 `.github/workflows/pages.yml`）。
4. 手机上打开 `https://<用户名>.github.io/<仓库名>/`，Safari 点分享 → 添加到主屏幕，Chrome 点菜单 → 安装应用。
5. 首次打开填入仓库和令牌：
   - GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
   - Repository access 选 Only select repositories，勾选这个笔记仓库
   - Permissions → Repository permissions → **Contents: Read and write**
6. 点「连接并开始」。

令牌只存在手机浏览器的 IndexedDB 里，不经过任何第三方服务器。

## 用起来

| 想做的事 | 做法 |
| --- | --- |
| 记一条 | 点底部输入框，写完点「发布」 |
| 加图片 | 编辑器里「图片」，可多选；拍照直接走系统相机 |
| 录音 | 编辑器里「录音」，或底部麦克风按钮，最长 10 分钟 |
| 加视频 | 编辑器里「视频」，拍或选，单条 25MB 以内 |
| 删除 | 笔记右上角「⋯」→ 删除；本地和仓库里的笔记、媒体一起删 |
| 找旧笔记 | 一直往上滑，滑到本地边界会自动从仓库拉更早的 |
| 搜 | 右上角放大镜。先搜本地；要搜全部历史点「在 GitHub 上搜索全部」 |
| 清理手机空间 | 设置 → 本地缓存 → 选一个日期 → 「清理此前」。只删本地副本，翻页时会自动回来 |

## 数据格式

笔记是一个带 frontmatter 的 Markdown，在 GitHub 网页上直接能读：

```markdown
---
id: 20261108T123045-7f3a
created: 2026-11-08T12:30:45+08:00
updated: 2026-11-08T12:31:10+08:00
media: [{"k":"m1","t":"image","p":"media/2026/11/20261108T123045-7f3a/m1.webp","m":"image/webp","w":1600,"h":1200,"dur":0}]
---
今天把这篇写完了。

顺手记一个链接 https://example.com
```

`id` 命名规则是 `YYYYMMDDTHHMMSS-随机4位`，按字符串排序就是时间顺序，所以文件树不用额外索引。

## 注意

- 仓库是公开的，**任何人都能读到你的笔记**。私密内容不要记。
- 仓库里放二进制会让 clone 变慢，建议定期用「清理此前」管住手机端，仓库端如果在意体积可以另开一个仓库放媒体（改 `store.js` 的 `mediaPath` 即可）。
- iOS 上如果长期不用，Safari 可能回收 PWA 的本地存储。数据都在仓库里，重新拉一遍就行。
- 令牌泄露等于把仓库写权限给出去，别把浏览器里的配置截图发出去。

## 目录

```
index.html            应用外壳
styles.css            样式
js/app.js             启动
js/ui.js              界面、编辑器、搜索、设置
js/store.js           状态与同步引擎（推送/回捞/删除/清理）
js/gh.js              GitHub Contents + Tree API
js/db.js              IndexedDB
js/media.js           图片压缩、录音、视频探测
js/util.js            工具函数
sw.js                 Service Worker（离线外壳 + 媒体缓存）
manifest.webmanifest  PWA 清单
.github/workflows/    GitHub Pages 自动部署
```

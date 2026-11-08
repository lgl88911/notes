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

## 部署并装到手机

这个 App 没有构建步骤，一个仓库同时当数据仓库和站点仓库。

1. 建一个**公开**仓库（比如 `notes`）。
2. 推到仓库根目录（`main` 分支）：
   ```bash
   git remote add origin git@github.com:<用户名>/notes.git
   git push -u origin main
   ```
3. 仓库 Settings → Pages → Source 选 **GitHub Actions**。仓库里已带 `.github/workflows/pages.yml`，推完自动部署，地址是 `https://<用户名>.github.io/notes/`。
4. 手机 Chrome 打开这个地址 → 菜单 → **安装应用**（或「添加到主屏幕」）。桌面出现图标，点开是全屏无地址栏的独立窗口。
5. 首次打开填三项：用户名、仓库名、令牌。令牌这样拿：
   - GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
   - Repository access 选 Only select repositories，勾选笔记仓库
   - Permissions → Repository permissions → **Contents: Read and write**
6. 点「连接并开始」。

令牌只存在手机浏览器的 IndexedDB 里，不经过任何第三方服务器。

### 关于「安装应用」入口

浏览器只在 **HTTPS 或 localhost** 下才把它当成可安装的应用，所以：

- 必须用 Pages 的 `https://` 地址，局域网 `http://192.168.x.x` 装不了。
- 手机 Chrome 菜单里没有「安装应用」时，先确认页面是从 HTTPS 打开的；再打开右上角「⋮」→「添加到主屏幕」，效果相同。
- 没有 Google 服务框架的国产手机，Chrome 可能只生成普通快捷方式（点开会带地址栏）。这种情况改用 Capacitor 打成 APK 更稳。

### 不部署，只想先在手机上试试

用数据线连手机，开 USB 调试，然后在电脑上：

```bash
adb reverse tcp:8765 tcp:8765
```

手机 Chrome 访问 `http://localhost:8765` 即可（localhost 算安全上下文，Service Worker 能注册）。这条命令每次插线都要重跑。

## 用起来

| 想做的事 | 做法 |
| --- | --- |
| 记一条 | 点底部输入框，写完点「发布」 |
| 加图片 | 编辑器里「图片」，可多选；拍照直接走系统相机 |
| 录音 | 编辑器里「录音」，或底部麦克风按钮，最长 10 分钟 |
| 加视频 | 编辑器里「视频」，拍或选，单条 25MB 以内 |
| 贴链接看图/听音 | 正文里直接贴 `.jpg .png .mp4 .mp3` 这类直链，笔记里会就地显示和播放，不用先上传 |
| 删除 | 笔记右上角「⋯」→ 删除；本地和仓库里的笔记、媒体一起删 |
| 找旧笔记 | 一直往上滑，滑到本地边界会自动从仓库拉更早的 |
| 搜 | 右上角放大镜。先搜本地；要搜全部历史点「在 GitHub 上搜索全部」 |
| 立刻和 GitHub 对一次 | 右上角转圈箭头：先把本地待推送的推上去，再拉一次仓库文件树 |
| 清理手机空间 | 设置 → 本地缓存 → 选一个日期 → 「清理此前」。只删本地副本，翻页时会自动回来 |

## 界面改了但手机上没变化

Service Worker 会把界面文件缓存到本地，正常情况下打开应用就会自动更新（界面文件走「先网络、失败才用缓存」，并且每次启动都会主动检查一次 `sw.js`）。如果还是看到旧界面：

1. 从最近任务里**划掉应用**再重新打开，而不是切到后台。
2. 设置 → 其他 → **检查更新**：清掉界面缓存并重新载入，笔记和令牌不受影响。
3. 仍然不行就看设置页底部的版本号，确认是不是已经是最新发布。

注意桌面上的**应用图标**是另一回事：它由 Chrome 根据 `manifest.webmanifest` 里的图标生成（WebAPK），改了 `icons/` 里的图之后，需要重新「安装应用」才会换。

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

# 抖音 AI 视频下载工具

> 仓库：`douyin-ai-video-downloader` ｜ skill 标识：`douyin-video-downloader`
>
> （skill 名必须是 kebab-case ASCII，写在 `SKILL.md` 的 frontmatter 里；仓库名与 skill 名可以不同）

抖音视频/图集下载器，同时是一个**可直接给 AI agent 用的 skill**（仓库根目录的 `SKILL.md`）。

核心思路：不去硬碰抖音的反爬，而是**借真实浏览器的手**——用 Chrome DevTools Protocol 打开播放页，
读出页面向自己详情 API 请求到的那份**最高码率完整 mp4** 直链，然后立刻下载。

## 为什么需要这样

抖音对无 Cookie 的程序化请求已经全面启用 JS-VMP 反爬 + 验证码中间页：

- `douyin.com` 任意页面在无 Cookie 时返回同一个 72,914 字节的挑战页，没有任何 `_ROUTER_DATA`
- 分享页的 SSR 数据里只剩渲染元信息，`videoInfoRes` / `item_list` / `play_addr` 全部移除
- 老接口 `iteminfo` / `slidesinfo` / `amemv detail` 返回 200 但 body 为 **0 字节**，`iesdouyin` 的老播放接口
  直接 **404**
- 第三方公共解析 API 要么 403，要么已改成需要登录鉴权

完整实测证据（含每个接口的原始返回）：[references/why-html-parsing-fails.md](references/why-html-parsing-fails.md)

而同一个链接在真实 Chrome 里完全正常。所以本工具让浏览器去拿直链，脚本只负责下载。

## 特性

- **优先取播放器实际使用的直链**：详情 API 的 `play_addr` / 最高码率档优先，`download_addr` 仅作兜底
- **完整音视频**：优先取详情 API 里含音视频的整段 mp4，而不是需要自己合并的 DASH 分轨
- **自动挑最高画质**：按 `bit_rate` 降序取最高档；档位不足 720p 时自动重抓一次再比
- **支持图集**：`note` 类型作品会抽出全部图片直链
- **登录态可选**：登录后解锁更高档位，登录态持久保存在 `.chrome-profile`
- **零重型依赖**：Python 端只要 `requests`，抓取用系统 Chrome + Node

## 环境要求

| 依赖 | 说明 |
|---|---|
| macOS | 脚本按 macOS 路径找 Chrome（Linux 需自行改 `CHROME` 变量） |
| Google Chrome | **必需**，且必须是 Chrome（Safari/Chromium 不支持 CDP） |
| Node.js ≥ 18 | 跑 CDP 抓取（用到全局 `WebSocket`，建议 20+） |
| Python ≥ 3.9 | 跑下载器 |

## 安装

```bash
git clone https://github.com/Awake118/douyin-ai-video-downloader.git
cd douyin-ai-video-downloader
./setup.sh
```

`setup.sh` 会检查依赖并创建 `.venv`＋装好 `requests`/`urllib3`。

## 用法

### 下载视频

```bash
./scripts/get_video.sh "https://v.douyin.com/xxxxxxx/" "我的视频"
```

输出 `downloads/我的视频.mp4`。直链带时效（含 `temp=1`，几分钟就失效），所以流程是「抓到即下」；
要重下就重跑。第一次抓到的档位低于 720p 时会自动再抓一次并合并候选取最高码率。

### 只看直链

```bash
node scripts/capture_media_url.js "https://v.douyin.com/xxxxxxx/" 9222 --wait=90
cat /tmp/douyin_urls.json
```

输出形如 `[{url, source, note}]`，按优先级排序：`source=api`（详情 API，最优）→ `network`（播放器整段请求）
→ `track`（DASH 分轨，需自行合并）。

### 单独下载一个直链

```bash
./.venv/bin/python scripts/download_url.py "<直链>" -o ./downloads --name 文件名
# 也可以直接吃 DevTools 的 "Copy as cURL" 文本
./.venv/bin/python scripts/download_url.py --from-curl ~/Desktop/curl.txt -o ./downloads
```

### 登录（解锁更高档位）

```bash
./scripts/login.sh                                 # 弹出 Chrome，手机抖音 App 扫码
node scripts/get_login_qr.js ./login_qr.png 9222   # 看不到窗口时：二维码存成图片再扫
./scripts/wait_login.sh 10                         # 等扫码完成，并把 Cookie 正常落盘
```

登录态存在 `.chrome-profile`，之后下载自动复用。

## 画质说明

抖音的档位由详情 API 的 `bit_rate` 数组给出，命名规律是 `normal_720_0` / `low_540_0` / `adapt_540_1`：

| 抖音的叫法 | 档位 | 分辨率 |
|---|---|---|
| 标清 | `*_540_*` | 1024×576 / 960×540 |
| 高清 | `*_720_*` | 1280×720 |

**未登录时网页端上限是 720p**；登录后部分作品才会出现 1080p 档位。但要注意：**很多作品源头就只有 720p**，
这时登录也没用。判断方法（含一个完整案例的数据）见 [references/quality-and-gears.md](references/quality-and-gears.md)。

## 作为 agent skill 使用

`SKILL.md` 采用通用的 skill bundle 格式（`<name>/SKILL.md` + YAML frontmatter + 资源目录），
可直接放进支持该格式的运行时：

```bash
# DeepSeek Harness：项目级
git clone https://github.com/Awake118/douyin-ai-video-downloader.git .dsh/skills/douyin-video-downloader
# 或用户级
git clone https://github.com/Awake118/douyin-ai-video-downloader.git ~/.dsh/skills/douyin-video-downloader
```

frontmatter 字段：`name`、`description`、`whenToUse`、`disable-model-invocation`、`user-invocable`。
Claude Code 等使用 `name` + `description` 的运行时同样可直接读取。

## 目录结构

```
.
├── SKILL.md                    # agent 指令（frontmatter + 工作流 + 约束）
├── setup.sh                    # 依赖检查 + 建 .venv
├── scripts/
│   ├── get_video.sh            # 一键：抓直链 + 下载
│   ├── capture_media_url.js    # CDP 抓取器（解析 ID、读详情 API、抽直链）
│   ├── download_url.py         # 直链下载器
│   ├── login.sh                # 扫码登录
│   ├── get_login_qr.js         # 把登录二维码截图存盘
│   ├── wait_login.sh           # 等登录完成并落盘
│   ├── check_login.js          # 查登录态
│   └── close_browser.js        # 优雅关闭 Chrome（保住 Cookie）
└── references/
    ├── why-html-parsing-fails.md   # 反爬实测证据
    └── quality-and-gears.md        # 画质档位判定
```

## 免责声明

- 仅供**个人收藏、学习、研究**。下载他人作品请遵守著作权法与平台服务条款，**二次发布需获得授权**。
- 含 AI 生成内容的视频带平台强制标识（显式标识 + 隐式元数据标识）。按《人工智能生成合成内容标识办法》
  （2025-09-01 施行），**传播时不得删除标识**——本项目不提供任何去标识能力。
- 请勿把 `.chrome-profile`（含你的抖音登录 Cookie）提交、分享或上传给任何第三方服务。

## License

MIT，见 [LICENSE](LICENSE)。

---
name: douyin-video-downloader
description: 下载抖音（Douyin）视频与图集。当用户给出抖音分享链接（v.douyin.com/xxx、www.douyin.com/video/<id>、www.douyin.com/note/<id>）并要求保存、下载、备份视频，或抱怨抖音下载器解析失败、画质只有标清、需要登录才能看高清时使用。通过真实 Chrome + DevTools Protocol 读取播放器真实直链，绕过抖音对无 Cookie 请求的 JS-VMP 反爬与验证码中间页。
whenToUse: 用户提供抖音链接要下载/保存，或需要排查抖音解析失败、画质档位、登录态问题。
---

# 抖音视频下载

用真实 Chrome 打开播放页，通过 CDP 读出详情 API 返回的**最高码率完整 mp4 直链**，立即下载。

## 为什么不能直接 HTTP 解析

抖音对无 Cookie 的程序化请求全面启用 JS-VMP 反爬 + 验证码中间页，纯脚本方案（HTML SSR 正则、老接口、
伪造 `a_bogus`）已全部失效，实测证据见 [references/why-html-parsing-fails.md](references/why-html-parsing-fails.md)。
真实浏览器能过风控，所以本 skill 借浏览器的手拿直链。

## 前置检查

```bash
./setup.sh        # 检查 node / python3 / Chrome，创建 .venv 并装依赖
```

## 主流程

```bash
./scripts/get_video.sh "<抖音分享链接>" "文件名"
```

- 支持短链 `v.douyin.com/...`、`douyin.com/video/<id>`、`douyin.com/note/<id>`
- 输出到 `downloads/<文件名>.mp4`（含音视频轨，可直接播放）
- 直链带时效（URL 含 `temp=1`，几分钟失效），流程是"抓到即下"；重下要重跑
- 第一次抓到的档位低于 720p 时脚本会自动再抓一次并合并候选，取码率最高的一条

只想要直链、不下载：

```bash
node scripts/capture_media_url.js "<链接>" 9222 --wait=90
cat /tmp/douyin_urls.json      # [{url, source, note}] 按优先级排序
```

已有直链要单独下载：

```bash
./.venv/bin/python scripts/download_url.py "<直链>" -o ./downloads --name 文件名
```

## 画质：先判断上限，再解释

档位由详情 API 的 `bit_rate` 数组给出，脚本按 kbps 降序取最高档。**未登录时抖音网页端上限是 720p
（`normal_720_0`）；登录后部分作品才会出现 1080p 档位。** 但很多作品源头就只有 720p——
先看抓取输出里的档位表，再下结论，别直接归因于"没登录"。判定方法与实测案例见
[references/quality-and-gears.md](references/quality-and-gears.md)。

要登录态（解锁更高的档位）：

```bash
./scripts/login.sh                              # 弹出 Chrome 扫码登录
node scripts/get_login_qr.js ./login_qr.png 9222  # 无法看到窗口时：把二维码截图存成文件再扫
./scripts/wait_login.sh 10                      # 等扫码完成并让 Cookie 落盘
```

登录态保存在 `.chrome-profile`，之后 `get_video.sh` 自动复用。

## 拿到链接后要做的检查

下载完成后核对两点，再把结论告诉用户：

1. **完整性**：`ftyp`/`moov`/`mdat` 齐全、有 `vide` 和 `soun` 两个轨道（不是无声的 DASH 分轨）
2. **画质**：读输出里的档位名与分辨率，确认是不是该作品的最高档

## 硬性约束

- **绝不提交 `.chrome-profile/`**：里面是用户的抖音登录 Cookie。仓库已用 `.gitignore` 排除，
  新增文件时不要绕过它，也不要把 Cookie 内容贴进 issue、日志或提交信息。
- **只用于个人收藏、学习、备份**。不要协助用户去掉视频自带的"内容由ai生成"等显式标识
  （按《人工智能生成合成内容标识办法》，传播时不得删除标识），也不要用于搬运他人作品二次发布。
- 抓取依赖用户自己的浏览器会话，**不要把 Cookie 交给任何第三方在线解析站**。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `解析失败: 从HTML中解析视频JSON信息失败` | 这是上游纯 HTML 方案的报错，本 skill 已不用该路径；确认跑的是 `scripts/get_video.sh` |
| 页面卡在"视频数据加载中"、0 条媒体请求 | 风控要求验证。改用有窗口模式（`./scripts/login.sh`），必要时手动过滑块 |
| `连不上 Chrome 调试端口 9222` | Chrome 已退出。脚本会自己拉起；也可删掉 `-rf .chrome-profile` 重来（会丢登录态） |
| 下载时报 `HTTP 404` | 直链过期，重跑 `get_video.sh` |
| 拿到 `text/html` 而不是视频 | CDN 拒绝了请求，多在直链过期或 Referer 不对；`download_url.py` 会明确报错而不是存假文件 |
| 画质只有 720p | 先确认作品本身是否提供 1080p 档位（见上），再考虑登录 |

# 为什么纯 HTTP 解析抖音已经不可行（实测证据）

测试时间：2026-09。测试链接：一条普通的 App 分享短链 `https://v.douyin.com/<code>/`。

结论：**抖音对无 Cookie 的程序化请求全面启用 JS-VMP 反爬 + 验证码中间页**。任何"抓 HTML 正则提 JSON""调老接口"
的方案都已失效。这就是本 skill 改用真实 Chrome + CDP 的原因。

## 逐层实测

| 探测 | 结果 |
|---|---|
| 短链 302 | `v.douyin.com/<code>` → `www.iesdouyin.com/share/video/<id>/?did=…&share_sign=…` |
| 分享页 SSR（桌面 UA） | 200、72,914 字节 **JS-VMP 挑战页**，无 `_ROUTER_DATA` |
| 分享页 SSR（iPhone UA + 完整 share 参数） | 200、35,934 字节，**有** `_ROUTER_DATA`，但 `loaderData['video_(id)/page']` 里只剩渲染元信息（`ua` / `isSpider` / `webId` / `lastPath` / `serverToken` / `abParams`…），**没有 `videoInfoRes` / `item_list` / `play_addr`** |
| `www.douyin.com` 首页（无 Cookie） | 200，固定 72,914 字节挑战页；带第一次响应给的 `__ac_nonce` 再请求 → **「验证码中间页」**（要真人滑块） |
| `douyin.com/aweme/v1/web/aweme/detail/`（无 `a_bogus`） | 200 但 **0 字节**（服务端静默丢弃） |
| `iesdouyin.com/aweme/v1/web/aweme/detail/` | **403** |
| `iesdouyin.com/web/api/v2/aweme/iteminfo/` | 200，**0 字节**（接口已下线） |
| `iesdouyin.com/web/api/v2/aweme/slidesinfo/` | 200，**0 字节** |
| `api.amemv.com` / `aweme.snssdk.com` / `api3-normal-c-lf.amemv.com` 老版 detail | 200 但**全部 0 字节** |
| `iesdouyin.com/aweme/v1/play*` 老播放接口（分享页里出现的地址） | **404** |
| `douyin.com/aweme/v1/play/?video_id=…&ratio=1080p\|720p\|540p` | **全部 404** |
| 第三方公共解析 API | `tikwm.com` → 403；`api.douyin.wtf` → 已改为 `/api/v1/auth/login` 登录鉴权 |
| headless Chrome 直接 `/User/self` 登录页 | 不弹登录框；页面还会加载 `rc-verifycenter` 风控 iframe |

## 两处根因

1. **签名**：抖音要求真实 `a_bogus` + `msToken`，并由浏览器 JS 生成。手写随机串（很多小项目就是这么干的）
   会被服务端静默丢弃——返回 200 + 0 字节，不报错，只让你拿到空数据。
2. **风控分层**：无 Cookie → JS-VMP 挑战页；带 `__ac_nonce` → 验证码中间页；headless 自动化 → 更容易被判风险，
   页面卡在"加载中"或"视频数据加载中"。

## 为什么换成 Chrome + CDP 就好了

同一个链接在真实 Chrome 里：页面正常渲染，`aweme/v1/web/aweme/detail/` 返回 200 且 body 完整，
播放器照常请求 `douyinvod.com` 上的媒体流。差别就在于浏览器执行了挑战 JS、带了真实签名与 Cookie。

所以本项目不逆向签名，而是**订阅 DevTools Protocol 的 Network 事件**，把浏览器自己拿到的直链读出来。

## 操作要点

- **必须有窗口 vs headless**：headless 常被风控卡住（实测有窗口模式下同一页面立刻正常）。抓取失败时先换有窗口模式。
- **自动播放会被拦**：播放器不发请求就没直链可抓。抓取脚本会先派发一次真实鼠标点击拿到用户手势，再 `muted=true; play()`。
- **页面偶发卡死**：脚本在 45 秒无进展时自动 `Page.reload` 重试（最多 2 次）。
- **登录态要正常落盘**：关 Chrome 必须走 CDP `Browser.close`，直接 kill 会丢 Cookie。见 `scripts/close_browser.js`。

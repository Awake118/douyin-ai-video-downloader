#!/usr/bin/env node
/**
 * 抖音视频直链抓取（Chrome DevTools Protocol）
 *
 * 背景：抖音对无 Cookie 的程序化请求启用 JS-VMP 反爬 + 验证码中间页，
 * 纯脚本解析（HTML SSR / 老接口）已全部失效；真实浏览器能过风控，
 * 所以这里让 Chrome 自己打开播放页，把它真正拿到的媒体直链交出来。
 *
 * 流程：
 *   1. 解析分享链接得到作品 ID（短链先跟随跳转）
 *   2. 用桌面版播放页 www.douyin.com/video/<id> 打开，订阅 Network
 *   3. 读详情 API 响应体，取 play_addr / bit_rate / download_addr（完整 mp4）
 *   4. 兜底：抓播放器实际请求的媒体 URL
 *
 * 用法: node capture_media_url.js "<分享链接或作品URL>" [端口] [--wait=秒]
 * 输出: /tmp/douyin_urls.json  ——  [{url, source, note}]，按优先级排序
 */

const args = process.argv.slice(2);
const PAGE_URL = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const PORT = args.find((a) => /^\d+$/.test(a)) || '9222';
const WAIT_SEC = Number((args.find((a) => a.startsWith('--wait=')) || '').split('=')[1] || 90);
const HTTP = `http://127.0.0.1:${PORT}`;
const OUT_FILE = '/tmp/douyin_urls.json';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

if (!PAGE_URL) {
  console.error('用法: node capture_media_url.js "<分享链接或作品URL>" [端口] [--wait=秒]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${HTTP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {}
    await sleep(500);
  }
  throw new Error(`连不上 Chrome 调试端口 ${PORT}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send, events };
}

const MEDIA_RE = /\.mp4(\?|$)|douyinvod|\/play\/|\/aweme\/v1\/play/i;
const TRACK_RE = /media-video-|media-audio-/;

function extractId(url) {
  const m = url.match(/\/(?:video|note|slides)\/(\d{6,})/) || url.match(/[?&]modal_id=(\d{6,})/);
  return m ? m[1] : null;
}

/** 从详情 API 的 JSON 里按优先级抽取完整 mp4 直链 */
function pickFromDetail(data) {
  const out = [];
  const push = (url, note) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    if (out.some((o) => o.url === url)) return;
    out.push({ url, source: 'api', note });
  };

  const aweme = data?.aweme_detail || data?.aweme_details?.[0] || data?.item_list?.[0] ||
                data?.videoData || data || {};

  // 1) bit_rate 里的各档位（含音视频的完整文件），按码率从高到低
  const rates = Array.isArray(aweme?.video?.bit_rate) ? [...aweme.video.bit_rate] : [];
  rates.sort((a, b) => (b?.bit_rate || 0) - (a?.bit_rate || 0));
  for (const r of rates) {
    const u = r?.play_addr?.url_list?.[0];
    push(u, `bit_rate ${r?.gear_name || ''} ${Math.round((r?.bit_rate || 0) / 1000)}kbps`);
  }

  // 2) video.play_addr（跟随 302 后的真实地址）
  for (const u of aweme?.video?.play_addr?.url_list || []) push(u, 'video.play_addr');
  for (const u of aweme?.video?.play_addr_h264?.url_list || []) push(u, 'play_addr_h264');
  for (const u of aweme?.video?.playApi || []) push(u, 'playApi');

  // 3) 图集
  for (const img of aweme?.images || []) {
    const u = img?.url_list?.[img.url_list.length - 1] || img?.url_list?.[0];
    push(u, '图集图片');
  }

  // 4) 下载地址（兜底）
  for (const u of aweme?.video?.download_addr?.url_list || []) push(u, 'download_addr(兜底)');

  return out;
}

function collectNetworkMedia(events) {
  const seen = new Map();
  for (const ev of events) {
    if (ev.method !== 'Network.responseReceived') continue;
    const { response, type } = ev.params;
    const url = response.url || '';
    const mime = (response.mimeType || '').toLowerCase();
    if ((type === 'Media' || mime.startsWith('video/') || MEDIA_RE.test(url)) && !seen.has(url)) {
      seen.set(url, {
        url,
        source: TRACK_RE.test(url) ? 'track' : 'network',
        note: `${response.status} ${mime || type}`,
      });
    }
  }
  return [...seen.values()];
}

(async () => {
  const target = await findPageTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable', { maxTotalBufferSize: 400 * 1024 * 1024 });
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  await cdp.send('Network.setUserAgentOverride', { userAgent: DESKTOP_UA, platform: 'MacIntel' });

  const evalJs = async (expression) => {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      return r.result?.value;
    } catch (e) {
      return null;
    }
  };

  // ---- 1. 拿到作品 ID（纯 HTTP 跟随跳转，不占用浏览器页面）----
  let id = extractId(PAGE_URL);
  if (!id) {
    console.log('[cdp] 短链，用 HTTP 跟随跳转解析作品 ID ...');
    try {
      const r = await fetch(PAGE_URL, { redirect: 'follow', headers: { 'User-Agent': DESKTOP_UA } });
      id = extractId(r.url);
      if (!id) {
        const html = await r.text();
        id = extractId((html.match(/(?:video|note)\/\d{6,}/) || [''])[0]);
      }
    } catch (e) {
      console.log(`    跳转解析失败: ${e.message}，改让浏览器解析`);
    }
    if (!id) {
      await cdp.send('Page.navigate', { url: PAGE_URL });
      for (let i = 0; i < 15 && !id; i++) {
        await sleep(1000);
        id = extractId(await evalJs('location.href'));
      }
    }
  }
  if (!id) throw new Error('没能从链接里解析出作品 ID');
  console.log(`[cdp] 作品 ID: ${id}`);

  // ---- 2. 打开桌面播放页，等详情 API ----
  const playUrl = `https://www.douyin.com/video/${id}`;
  console.log(`[cdp] 打开播放页（桌面 UA）: ${playUrl}`);
  await cdp.send('Page.navigate', { url: playUrl });

  const detailBodies = [];
  const deadline = Date.now() + WAIT_SEC * 1000;
  let clickDone = false;
  let lastReport = 0;
  let reloads = 0;

  const seenDetail = new Set();
  while (Date.now() < deadline) {
    await sleep(3000);

    // 收集详情 API 响应体
    for (const ev of cdp.events) {
      if (ev.method !== 'Network.responseReceived') continue;
      const { requestId, response } = ev.params;
      if (seenDetail.has(requestId)) continue;
      if (!/aweme\/v1\/web\/aweme\/detail|aweme\/v2\/aweme\/detail|slidesinfo/i.test(response.url || '')) continue;
      seenDetail.add(requestId);
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId });
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        if (text && text.length > 100) {
          detailBodies.push(text);
          console.log(`[cdp] 拿到详情 API 响应（${text.length} 字节）`);
        }
      } catch (e) {}
    }
    if (detailBodies.length && collectNetworkMedia(cdp.events).length) break;

    // 触发播放：拿用户手势 + 静音播放
    const st = await evalJs(`(() => {
      const v = document.querySelector('video');
      if (!v) return 'no-video';
      v.muted = true;
      const p = v.play(); if (p && p.catch) p.catch(() => {});
      return 'ready=' + v.readyState + ' src=' + (v.currentSrc || v.src || '').slice(0, 90);
    })()`);
    if (!clickDone) {
      try {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', { type, x: 640, y: 400, button: 'left', clickCount: 1 });
        }
      } catch (e) {}
      clickDone = true;
    }

    const elapsed = Math.round((Date.now() - (deadline - WAIT_SEC * 1000)) / 1000);
    if (elapsed - lastReport >= 15) {
      lastReport = elapsed;
      console.log(`[cdp] ${elapsed}s 状态: ${st}`);
    }

    // 页面偶尔卡在「加载中」再也不发请求；45 秒还没动静就刷一次
    if (elapsed >= 45 && !detailBodies.length && reloads < 2 && st === 'no-video') {
      reloads++;
      console.log(`[cdp] 页面卡住了，第 ${reloads} 次刷新重试 ...`);
      try {
        await cdp.send('Page.reload', { ignoreCache: false });
      } catch (e) {}
      clickDone = false;
      lastReport = elapsed;
      await sleep(4000);
    }
  }

  // ---- 3. 汇总候选 ----
  const apiPicks = [];
  for (const text of detailBodies) {
    try {
      apiPicks.push(...pickFromDetail(JSON.parse(text)));
    } catch (e) {}
  }
  const netPicks = collectNetworkMedia(cdp.events);
  const picks = [...apiPicks, ...netPicks];

  console.log('\n===== 结果 =====');
  console.log(`详情 API 响应 ${detailBodies.length} 份，网络媒体请求 ${netPicks.length} 条`);
  picks.slice(0, 15).forEach((p, i) => console.log(`  ${i + 1}. [${p.source}] ${p.note || ''}\n     ${p.url.slice(0, 170)}`));

  if (!picks.length) {
    console.error('\n没抓到任何直链。常见原因：链接失效/私密、需要登录、页面加载太慢（可加大 --wait）。');
    cdp.ws.close();
    process.exit(1);
  }

  const fs = await import('node:fs');
  fs.writeFileSync(OUT_FILE, JSON.stringify(picks, null, 2));
  console.log(`\n候选直链已写入 ${OUT_FILE}（${picks.length} 条，按优先级排序）`);
  cdp.ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('抓取失败:', e.message);
  process.exit(1);
});

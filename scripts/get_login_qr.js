#!/usr/bin/env node
/**
 * 取抖音网页登录二维码：打开登录页 → 把二维码截图存成 PNG。
 *
 * 用法: node get_login_qr.js <输出PNG路径> [端口]
 * 退出码: 0 拿到二维码 / 1 已登录（不需要二维码）/ 2 失败
 *
 * 为什么这么干：headless Chrome 不开窗口也能渲染二维码，
 * 截图落盘后用户直接扫图片，不受窗口是否可见、是否被遮挡影响。
 */

const OUT = process.argv[2] || 'login_qr.png';
const PORT = process.argv[3] || '9222';
const HTTP = `http://127.0.0.1:${PORT}`;
const LOGIN_PAGE = 'https://www.douyin.com/user/self';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 30; i++) {
    let list = [];
    try {
      list = await (await fetch(`${HTTP}/json/list`)).json();
    } catch (e) {
      await sleep(1000);
      continue;
    }
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page;
    // 没有页面就自己开一个
    try {
      await fetch(`${HTTP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    } catch (e) {}
    await sleep(1000);
  }
  throw new Error('找不到可用的页面 target');
}

(async () => {
  const page = await findPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = id++;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false });

  // 先看是不是已经登录了
  const cookies = (await send('Network.getCookies', { urls: ['https://www.douyin.com'] })).result?.cookies || [];
  const names = new Set(cookies.map((c) => c.name));
  if (['sessionid', 'sessionid_ss', 'sid_tt'].some((n) => names.has(n))) {
    console.log('logged_in: 已经登录，无需二维码');
    ws.close();
    process.exit(1);
  }

  console.log(`打开抖音首页: ${LOGIN_PAGE}`);
  await send('Page.navigate', { url: LOGIN_PAGE });
  await sleep(6000);

  // 登录框不一定自动弹，找不到二维码就主动点一下「登录」入口
  const CLICK_LOGIN_JS = `(() => {
    const txt = (document.body ? document.body.innerText : '');
    if (/扫码登录|扫一扫登录/.test(txt)) return '';   // 登录框已经开了，别再点（会关掉）
    const cands = [...document.querySelectorAll('button, div, span, a')].filter((el) => {
      if ((el.textContent || '').trim() !== '登录') return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.width < 160 && r.height > 10 && r.height < 60;
    });
    if (!cands.length) return '';
    const el = cands[cands.length - 1];
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`;

  // 等二维码真正渲染出来：只认"方形 + 有足够多暗像素"的 canvas，
  // 避免把还没加载完的占位图（只有抖音 logo）截下来。
  let box = null;
  let clicks = 0;
  for (let i = 0; i < 60; i++) {
    box = await ev(`(() => {
      const rectOf = (el) => { const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      for (const el of document.querySelectorAll('canvas')) {
        const r = rectOf(el);
        if (r.width < 120 || Math.abs(r.width - r.height) > 12) continue;
        let nonBlank = true;
        try {
          const d = el.getContext('2d').getImageData(0, 0, Math.min(el.width, 200), Math.min(el.height, 200)).data;
          let dark = 0;
          for (let k = 0; k < d.length; k += 4) if (d[k] < 100) dark++;
          nonBlank = dark > 50;
        } catch (e) { nonBlank = true; }
        if (nonBlank) return JSON.stringify(r);
      }
      return '';
    })()`);
    if (box) break;

    // 每 9 秒尝试一次：点「登录」入口把扫码框调出来
    if (i % 6 === 5 && clicks < 4) {
      const pt = await ev(CLICK_LOGIN_JS);
      if (pt) {
        const { x, y } = JSON.parse(pt);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
        clicks++;
        console.log(`  已点击「登录」入口（第 ${clicks} 次），等扫码框出现 ...`);
      } else if (i === 5) {
        console.log('  页面上没找到「登录」入口，继续等二维码 ...');
      }
    }
    await sleep(1500);
  }

  if (!box) {
    console.error('等了 90 秒仍没渲染出二维码（登录框没弹出或二维码接口失败）。');
    console.error('可以重跑一次；仍不行的话改用有窗口模式：./scripts/login.sh');
    ws.close();
    process.exit(2);
  }

  box = JSON.parse(box);
  {
    // 二维码四周留点白边，方便扫码
    const pad = 16;
    box = {
      x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad),
      width: box.width + pad * 2, height: box.height + pad * 2,
    };
  }

  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...box, scale: 2 },
    captureBeyondViewport: false,
  });
  const data = shot.result?.data;
  if (!data) throw new Error('截图失败');

  const fs = await import('node:fs');
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
  const size = fs.statSync(OUT).size;
  console.log(`二维码已保存: ${OUT} (${(size / 1024).toFixed(0)} KB, 区域 ${Math.round(box.width)}x${Math.round(box.height)})`);
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('取二维码失败:', e.message);
  process.exit(2);
});

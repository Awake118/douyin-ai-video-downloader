#!/usr/bin/env node
/**
 * 检查 Chrome（CDP）当前是否已登录抖音。
 * 用法: node check_login.js [端口]
 * 输出: logged_in | not_logged_in | no_cdp
 * 退出码: 0 已登录 / 1 未登录 / 2 连不上 CDP
 */

const PORT = process.argv[2] || '9222';
const HTTP = `http://127.0.0.1:${PORT}`;

const LOGIN_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'passport_assist_user', 'uid_tt'];

async function main() {
  let page;
  try {
    const list = await (await fetch(`${HTTP}/json/list`)).json();
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch (e) {
    console.log('no_cdp');
    process.exit(2);
  }
  if (!page) {
    console.log('no_cdp');
    process.exit(2);
  }

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

  await send('Network.enable');
  const cookieRes = await send('Network.getCookies', { urls: ['https://www.douyin.com', 'https://www.douyin.com/'] });
  const cookies = cookieRes.result?.cookies || [];
  const names = new Set(cookies.map((c) => c.name));
  const hit = LOGIN_COOKIES.filter((n) => names.has(n));

  console.log(hit.length ? 'logged_in' : 'not_logged_in');
  console.log(`  cookie 共 ${names.size} 个，登录标记: ${hit.join(', ') || '(无)'}`);
  ws.close();
  process.exit(hit.length ? 0 : 1);
}

main().catch(() => {
  console.log('no_cdp');
  process.exit(2);
});

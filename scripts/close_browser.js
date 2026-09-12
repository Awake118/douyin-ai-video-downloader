#!/usr/bin/env node
/**
 * 优雅关闭 CDP 控制的 Chrome（会把 Cookie 正常落盘，登录态才保得住）。
 * 用法: node close_browser.js [端口]
 * 只关我们自己启动的那个实例，不会动用户日常用的 Chrome。
 */

const PORT = process.argv[2] || '9222';

(async () => {
  let wsUrl;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    wsUrl = ver.webSocketDebuggerUrl;
  } catch (e) {
    console.log('no_cdp');
    process.exit(0);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r);
    ws.addEventListener('error', () => j(new Error('connect failed')));
  });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('closed');
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.log('close failed:', e.message);
  process.exit(0);
});

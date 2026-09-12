#!/usr/bin/env bash
# 让下载用的 Chrome 登录抖音，从而解锁 1080p 等高画质档位。
#
# 用法: ./scripts/login.sh
#
# 会弹出一个 Chrome 窗口打开抖音首页，用手机抖音 App 扫码登录即可。
# 登录态保存在项目内的 .chrome-profile（不会被 /tmp 清理），
# 之后 get_video.sh 复用同一个 profile，就一直带登录态抓取。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/scripts"
PROFILE="$ROOT/.chrome-profile"
PORT="${CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WAIT_MIN="${WAIT_MIN:-10}"

command -v node >/dev/null || { echo "需要 node" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "找不到 Google Chrome" >&2; exit 1; }

cdp_up() { curl -sS --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }
login_state() { node "$HERE/check_login.js" "$PORT" 2>/dev/null | head -1; }

if [ "$(login_state)" = "logged_in" ]; then
  echo "已是登录状态（profile: $PROFILE），无需重复扫码。"
  node "$HERE/check_login.js" "$PORT" 2>/dev/null | tail -1
  exit 0
fi

if cdp_up; then
  echo "端口 $PORT 上已有 Chrome 在跑，但未登录抖音。"
  echo "请先关闭它（或换 CDP_PORT 端口）后重跑本脚本。"
  exit 1
fi

mkdir -p "$PROFILE"
echo "启动 Chrome（独立 profile，不影响你日常浏览器的登录态）..."
# 用 open -na 走 LaunchServices，保证窗口正常弹到桌面上
open -na "Google Chrome" --args \
  --remote-debugging-port="$PORT" --remote-allow-origins='*' \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --window-size=1200,900 \
  --new-window "https://www.douyin.com/"

for _ in $(seq 1 40); do cdp_up && break; sleep 1; done
cdp_up || { echo "Chrome 没起来，日志：/tmp/dsh-login-chrome.log" >&2; exit 1; }

echo
echo "======================================================"
echo " 窗口已弹出，请用手机抖音 App 扫码登录"
echo " （抖音首页右上角「登录」→ 扫码；登录后脚本会自动检测到）"
echo " 最多等待 ${WAIT_MIN} 分钟 ..."
echo "======================================================"
echo

OK=0
for _ in $(seq 1 $((WAIT_MIN * 6))); do
  if [ "$(login_state)" = "logged_in" ]; then OK=1; break; fi
  sleep 10
done

if [ "$OK" = "1" ]; then
  echo "✓ 登录成功，登录态已写入 profile："
  node "$HERE/check_login.js" "$PORT" 2>/dev/null | tail -1
  echo "  正常关闭 Chrome（确保 Cookie 落盘）..."
  node "$HERE/close_browser.js" "$PORT" >/dev/null 2>&1 || true
  sleep 3
  echo
  echo "现在可以跑：./scripts/get_video.sh \"<分享链接>\" 文件名"
else
  echo "✗ 超时仍未检测到登录。窗口先留着，登录完成后可重跑本脚本确认。" >&2
  exit 1
fi

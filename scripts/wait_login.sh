#!/usr/bin/env bash
# 等待抖音扫码登录完成：轮询登录态，成功后正常关闭 Chrome 让 Cookie 落盘。
# 用法: ./wait_login.sh [最长等待分钟]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/scripts"
PORT="${CDP_PORT:-9222}"
MINUTES="${1:-10}"

state() { node "$HERE/check_login.js" "$PORT" 2>/dev/null | head -1; }

for i in $(seq 1 $((MINUTES * 6))); do
  if [ "$(state)" = "logged_in" ]; then
    echo "✓ 检测到登录成功（第 $((i * 10)) 秒）"
    node "$HERE/check_login.js" "$PORT" 2>/dev/null | tail -1
    node "$HERE/close_browser.js" "$PORT" >/dev/null 2>&1 || true
    sleep 3
    echo "  登录态已写入 $ROOT/.chrome-profile，Chrome 已正常关闭"
    exit 0
  fi
  sleep 10
done

echo "✗ ${MINUTES} 分钟内未检测到登录（二维码可能已过期，重新生成一张再扫）"
exit 1

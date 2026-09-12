#!/usr/bin/env bash
# 环境准备：检查依赖 + 创建 Python 虚拟环境
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

echo "== 检查依赖 =="
fail=0
if command -v node >/dev/null; then echo "  ✓ node $(node -v)"; else echo "  ✗ 缺 node（抓取脚本需要，https://nodejs.org）"; fail=1; fi
PY_BIN=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null; then PY_BIN="$cand"; break; fi
done
if [ -n "$PY_BIN" ]; then
  echo "  ✓ $PY_BIN $("$PY_BIN" -V 2>&1 | awk '{print $2}')"
else
  echo "  ✗ 缺 python3"; fail=1
fi
if [ -x "$CHROME" ]; then
  echo "  ✓ Google Chrome $("$CHROME" --version 2>/dev/null | awk '{print $3}')"
else
  echo "  ✗ 找不到 Google Chrome（路径：$CHROME）"
  echo "    Chrome 是抓取的核心：抖音对无 Cookie 的程序化请求启用 JS-VMP 反爬，"
  echo "    必须借真实浏览器过风控。Safari / Chromium 不支持 CDP，请装 Chrome。"
  fail=1
fi
[ "$fail" = "0" ] || { echo; echo "补齐上面的依赖后重跑本脚本。"; exit 1; }

echo
echo "== 创建虚拟环境 =="
if [ -x "$ROOT/.venv/bin/python" ]; then
  CUR="$("$ROOT/.venv/bin/python" -V 2>&1 | awk '{print $2}')"
  echo "  已存在：$ROOT/.venv（python $CUR）"
  echo "  想换解释器：rm -rf .venv 后重跑本脚本"
else
  "$PY_BIN" -m venv "$ROOT/.venv"
  echo "  已创建：$ROOT/.venv（基于 $PY_BIN）"
fi

echo
echo "== 安装依赖 =="
"$ROOT/.venv/bin/python" -m pip install --upgrade pip --quiet
"$ROOT/.venv/bin/python" -m pip install --quiet requests urllib3
"$ROOT/.venv/bin/python" - <<'EOF'
import requests, urllib3, sys
print(f"  ✓ python {sys.version.split()[0]} / requests {requests.__version__} / urllib3 {urllib3.__version__}")
EOF

echo
echo "准备完成。下一步："
echo "  ./scripts/get_video.sh \"<抖音分享链接>\" \"文件名\""
echo
echo "想要更高画质（1080p 档位需要登录态）："
echo "  ./scripts/login.sh          # 弹出 Chrome 扫码，登录态存在 .chrome-profile"

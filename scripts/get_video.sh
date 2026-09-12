#!/usr/bin/env bash
# 抖音视频一键下载：用 Chrome 打开播放页 → CDP 读详情 API 的真实直链 → 立即下载
#
# 用法:
#   ./scripts/get_video.sh "<抖音分享链接>" [文件名(不含扩展名)] [--headed] [--wait=秒] [--port=N]
#
# 为什么这么做：抖音对无 Cookie 的程序化请求启用 JS-VMP 反爬 + 验证码中间页，
# 纯脚本解析（HTML/老接口）已全部失效；真实浏览器能过风控，让浏览器自己把直链交出来最可靠。
#
# 模式：默认 headless；被风控卡住（页面卡在"加载中"、抓不到任何媒体请求）时
# 自动降级为有窗口模式重试一次 —— 实测有窗口模式对风控友好得多。--headed 可直接强制。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERE="$ROOT/scripts"
PY="$ROOT/.venv/bin/python"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE="$ROOT/.chrome-profile"          # 持久化 profile：保存抖音登录态
OUT_DIR="$ROOT/downloads"
URLS_FILE="/tmp/douyin_urls.json"
MERGED_FILE="/tmp/douyin_picks_merged.json"
CHOSEN_FILE="/tmp/douyin_chosen.txt"
CHROME_LOG="/tmp/douyin-chrome.log"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"

PORT="${CDP_PORT:-9222}"
WAIT="${WAIT_SEC:-90}"
FORCE_HEADED=0
FORCE_HEADLESS=0
POSITIONAL=()

for arg in "$@"; do
  case "$arg" in
    --headed) FORCE_HEADED=1 ;;
    --headless) FORCE_HEADLESS=1 ;;
    --wait=*) WAIT="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    --help|-h) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "未知参数：$arg（可用：--headed --headless --wait=秒 --port=N）" >&2; exit 2 ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

URL="${POSITIONAL[0]:-}"
NAME="${POSITIONAL[1]:-douyin_$(date +%Y%m%d_%H%M%S)}"

if [ -z "$URL" ]; then
  echo "用法: $0 \"<抖音分享链接>\" [文件名] [--headed] [--wait=秒] [--port=N]" >&2
  exit 2
fi
[ -x "$PY" ] || { echo "缺少虚拟环境，先跑：./setup.sh" >&2; exit 1; }
command -v node >/dev/null || { echo "需要 node（用于 CDP 抓包）" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "找不到 Google Chrome：$CHROME" >&2; exit 1; }

STARTED_CHROME=0
MODE="headless"
[ "$FORCE_HEADED" = "1" ] && MODE="headed"
[ "$FORCE_HEADLESS" = "1" ] && MODE="headless"

cdp_up() { curl -sS --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; }

launch_chrome() { # $1: headless | headed
  local mode="$1"
  mkdir -p "$PROFILE"
  local common=(--remote-debugging-port="$PORT" --remote-allow-origins='*'
    --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check
    --disable-blink-features=AutomationControlled --mute-audio
    --autoplay-policy=no-user-gesture-required --window-size=1280,900
    --user-agent="$UA")
  if [ "$mode" = "headless" ]; then
    nohup "$CHROME" --headless=new "${common[@]}" about:blank >"$CHROME_LOG" 2>&1 &
  else
    # 走 LaunchServices，保证窗口真的弹出来
    open -na "Google Chrome" --args "${common[@]}" --new-window "https://www.douyin.com/"
  fi
  for _ in $(seq 1 40); do cdp_up && return 0; sleep 1; done
  return 1
}

kill_chrome() { node "$HERE/close_browser.js" "$PORT" >/dev/null 2>&1 || true; sleep 2; }

cleanup() { [ "$STARTED_CHROME" = "1" ] && kill_chrome; }
trap cleanup EXIT

# ---- 1. 准备浏览器 ----
if cdp_up; then
  echo "[1/4] 复用已在运行的 Chrome（端口 $PORT）"
else
  echo "[1/4] 启动 $MODE Chrome（端口 $PORT，profile: $PROFILE）..."
  launch_chrome "$MODE" || { echo "Chrome 没能起来，日志：$CHROME_LOG" >&2; exit 1; }
  STARTED_CHROME=1
fi

LOGIN_STATE="$(node "$HERE/check_login.js" "$PORT" 2>/dev/null | head -1 || true)"
if [ "$LOGIN_STATE" = "logged_in" ]; then
  echo "    登录态：已登录"
else
  echo "    登录态：未登录 —— 抖音网页端游客档位上限通常为 720p"
  echo "    需要登录态时跑一次：./scripts/login.sh（登录态长期保存在 .chrome-profile）"
fi

# ---- 2. 抓直链（含 ABR 重试）----
# 服务端按播放器自适应码率（ABR）返回档位，一次可能只给到 540p；
# 若最高档不足 720p 就再抓一次并合并候选，最后取码率最高的一条。
run_capture() {
  for attempt in 1 2; do
    [ "$attempt" = "2" ] && echo "    最高档不足 720p，再抓一次..."
    rm -f "$URLS_FILE"
    if ! node "$HERE/capture_media_url.js" "$URL" "$PORT" --wait="$WAIT"; then
      [ "$attempt" = "1" ] && return 1
      break
    fi
    BEST=$("$PY" - "$URLS_FILE" "$MERGED_FILE" <<'PYEOF'
import json, re, sys
src, merged_path = sys.argv[1], sys.argv[2]
try:
    merged = json.load(open(merged_path))
except Exception:
    merged = []
have = {p['url'] for p in merged}
for p in json.load(open(src)):
    if p['url'] not in have:
        merged.append(p); have.add(p['url'])
json.dump(merged, open(merged_path, 'w'), ensure_ascii=False, indent=2)
best = 0
for p in merged:
    m = re.search(r'(\d+)kbps', p.get('note', ''))
    if m:
        best = max(best, int(m.group(1)))
print(best)
PYEOF
)
    COUNT=$("$PY" -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$MERGED_FILE" 2>/dev/null || echo '?')
    echo "    本轮最高码率 ${BEST}kbps（候选累计 ${COUNT} 条）"
    # 1400kbps 以上基本就是 720p 档，够用，不再重试
    [ "${BEST:-0}" -ge 1400 ] && break
  done
  return 0
}

echo "[2/4] 抓取真实直链..."
rm -f "$URLS_FILE" "$MERGED_FILE"
if ! run_capture; then
  if [ "$FORCE_HEADLESS" = "1" ] || [ "$MODE" = "headed" ] || [ "$STARTED_CHROME" = "0" ]; then
    cat >&2 <<'EOF'
没抓到媒体直链。常见原因：
  · 链接失效 / 作品私密
  · 风控要求验证：改用有窗口模式（加 --headed），必要时在窗口里手动过滑块
  · 页面加载慢：加大 --wait（如 --wait=150）
  · 复用了一个状态异常的 Chrome：关掉它或换 --port
EOF
    exit 1
  fi
  echo "    headless 被风控卡住了，改用有窗口模式重试 ..."
  kill_chrome
  launch_chrome headed || { echo "有窗口模式也没起来" >&2; exit 1; }
  MODE="headed"
  rm -f "$URLS_FILE" "$MERGED_FILE"
  run_capture || { echo "有窗口模式下仍未抓到直链。" >&2; exit 1; }
fi

# ---- 3. 挑选直链 ----
echo "[3/4] 挑选可用直链..."
"$PY" - "$MERGED_FILE" "$CHOSEN_FILE" <<'PYEOF'
import json, re, sys
picks = json.load(open(sys.argv[1]))
# source 含义：
#   api     —— 详情 API 给的 play_addr/bit_rate，一般是含音视频的完整 mp4，最优
#   network —— 播放器实际请求、且不是 DASH 分轨的整段文件
#   track   —— DASH 分轨（media-video-* 纯视频 / media-audio-* 纯音频），需自己合并，最后兜底
api = [p for p in picks if p.get('source') == 'api']
net = [p for p in picks if p.get('source') == 'network']
track = [p for p in picks if p.get('source') == 'track']

def kbps(p):
    m = re.search(r'(\d+)kbps', p.get('note', ''))
    return int(m.group(1)) if m else 0

api.sort(key=kbps, reverse=True)
chosen, why = (api[:1], '详情 API 完整 mp4') if api else \
              ((net[:1], '播放器整段请求') if net else (track, 'DASH 分轨（音视频分离，需自行合并）'))
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    f.write('\n'.join(p['url'] for p in chosen) + ('\n' if chosen else ''))
print(f"    候选 {len(picks)} 条 → 选中 {len(chosen)} 条（{why}）")
for p in chosen:
    print(f"      {p.get('note','')} {p['url'][:100]}")
PYEOF

[ -s "$CHOSEN_FILE" ] || { echo "没有可用直链" >&2; exit 1; }
TOTAL=$(wc -l < "$CHOSEN_FILE" | tr -d ' ')

# ---- 4. 下载 ----
echo "[4/4] 下载到 $OUT_DIR ..."
mkdir -p "$OUT_DIR"
i=0
while IFS= read -r u; do
  [ -n "$u" ] || continue
  i=$((i+1))
  suffix=""
  [ "$TOTAL" -gt 1 ] && suffix="_$i"
  "$PY" "$HERE/download_url.py" "$u" -o "$OUT_DIR" --name "${NAME}${suffix}"
done < "$CHOSEN_FILE"

echo
echo "完成，文件在：$OUT_DIR"
ls -lh "$OUT_DIR" | tail -n +2
echo
echo "提示：直链带时效（含 temp=1，几分钟失效），要重下就重跑本脚本。"

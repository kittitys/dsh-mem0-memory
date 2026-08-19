#!/usr/bin/env bash
# ============================================================
#  dsh-mem0-memory — 启动本地 mem0 server（Linux / macOS）
#  用法: ./start-server.sh [port]        （默认 18200）
#  启动后轮询 /health 直到 healthy，然后保持前台运行（Ctrl+C 停止）
# ============================================================
set -euo pipefail

PORT="${1:-18200}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 依赖快速检查
python3 -c "import mem0, jieba, flask" 2>/dev/null || {
  echo "[start-server] 依赖缺失：请先运行  python3 setup.py --init --install"
  exit 1
}

echo "[start-server] 启动 mem0-server on port ${PORT} ..."
python3 "${DIR}/mem0-server.py" --port "${PORT}" &
SERVER_PID=$!
trap 'kill ${SERVER_PID} 2>/dev/null || true' EXIT

# 健康自检：最多等 120 秒
for i in $(seq 1 60); do
  STATUS=$(curl -s -m 3 "http://127.0.0.1:${PORT}/health" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || true)
  case "$STATUS" in
    healthy)
      echo "[start-server] OK: healthy（端口 ${PORT}）"
      echo "[start-server] 停止：Ctrl+C"
      wait ${SERVER_PID}
      exit 0
      ;;
    init_failed)
      echo "[start-server] FAIL: 初始化失败"
      exit 1
      ;;
    *)
      echo "[start-server] 初始化中（$((i*2))s）..."
      sleep 2
      ;;
  esac
done
echo "[start-server] FAIL: /health 超时（120s）"
exit 1

#!/usr/bin/env bash
# 自检：起服务 → 打接口 → 配一个 B 站房间 → 收 25 秒 /ws 消息
# 用法：bash tools/selftest.sh [B站房间号]
cd "$(dirname "$0")/.." || exit 1

ROOM="${1:-21452505}"
PORT=7822
TMPCONF="$(mktemp -t danmu-selftest-XXXXXX).json"
echo '{"port":7822,"rooms":{"bilibili":{"roomId":"","cookie":""},"douyin":{"roomId":"","cookie":""}},"display":{}}' > "$TMPCONF"

DANMU_CONFIG="$TMPCONF" PORT=$PORT node server/index.js > /tmp/danmu-selftest.log 2>&1 &
PID=$!
sleep 2

pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1 (期望 $3，实际 $2)"; fail=$((fail+1)); fi
}

echo "[1/3] HTTP 接口"
for p in / /control.html /app.js /style.css /api/state; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT$p")
  check "GET $p" "$code" "200"
done

echo "[2/3] 配置 B 站房间 $ROOM"
curl -s -X POST "http://127.0.0.1:$PORT/api/config" -H 'content-type: application/json' \
  -d "{\"rooms\":{\"bilibili\":{\"roomId\":\"$ROOM\",\"cookie\":\"\"}}}" > /dev/null
sleep 6
state=$(curl -s "http://127.0.0.1:$PORT/api/state")
echo "$state" | grep -q "\"status\":\"connected\"" && { echo "  ✓ B 站已连接"; pass=$((pass+1)); } || { echo "  ✗ B 站未连接：$(echo "$state" | head -c 200)"; fail=$((fail+1)); }

echo "[3/3] 收 25 秒弹幕"
node -e "
import('ws').then(({default: WebSocket}) => {
  const ws = new WebSocket('ws://127.0.0.1:$PORT/ws');
  let n = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'message' && m.message.kind === 'chat') n++;
  });
  setTimeout(() => {
    console.log('  ' + (n > 0 ? '✓' : '✗') + ' 收到 ' + n + ' 条弹幕');
    process.exit(n > 0 ? 0 : 1);
  }, 25000);
});
"
rc=$?
[ $rc -eq 0 ] && pass=$((pass+1)) || fail=$((fail+1))

kill $PID 2>/dev/null; rm -f "$TMPCONF"
sleep 1
echo ""
echo "结果：$pass 通过，$fail 失败"
exit $fail

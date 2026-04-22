#!/usr/bin/env bash
# Smoke-test the LG Local Remote HTTP API against the paired device.
set -euo pipefail

DEVICE="${DEVICE:-mypanel}"
DEVICE_HOST="${DEVICE_HOST:-$(awk -F'"' '/"name":[[:space:]]*"'"$DEVICE"'"/,/"host"/ {if ($2=="host") print $4}' "$HOME/.webos/signage/novacom-devices.json" 2>/dev/null | head -1)}"
DEVICE_HOST="${DEVICE_HOST:-$DEVICE}"
HTTP_PORT="${HTTP_PORT:-9999}"
BASE="http://${DEVICE_HOST}:${HTTP_PORT}"

echo "Target: $BASE"

echo
echo "=== GET /health ==="
curl -sS -m 5 "$BASE/health" | jq .

echo
echo "=== GET /input ==="
curl -sS -m 10 "$BASE/input" | jq .

echo
echo "=== GET /screenshot (saved to /tmp/lglr-shot.jpg) ==="
curl -sS -m 20 -o /tmp/lglr-shot.jpg -w "HTTP %{http_code}  ct: %{content_type}  bytes: %{size_download}  time: %{time_total}s\n" "$BASE/screenshot"
file /tmp/lglr-shot.jpg

echo
echo "=== GET /screenshot (PNG) ==="
curl -sS -m 20 -o /tmp/lglr-shot.png -w "HTTP %{http_code}  ct: %{content_type}  bytes: %{size_download}\n" "$BASE/screenshot?format=PNG"
file /tmp/lglr-shot.png 2>/dev/null || true

echo
echo "=== GET /nope (expect 404) ==="
curl -sS -m 5 -w "\n[HTTP %{http_code}]\n" "$BASE/nope"

echo
echo "Skip with: SKIP_POST=1 $0  (POST tests change panel state)"
if [ "${SKIP_POST:-0}" != "1" ]; then
    echo
    echo "=== POST /input {src:'ext://hdmi:1'} ==="
    curl -sS -m 10 -X POST -H 'content-type: application/json' -d '{"src":"ext://hdmi:1"}' "$BASE/input" | jq .
    sleep 2
    echo
    echo "=== POST /input {type:'HDMI', index:0} ==="
    curl -sS -m 10 -X POST -H 'content-type: application/json' -d '{"type":"HDMI","index":0}' "$BASE/input" | jq .
fi

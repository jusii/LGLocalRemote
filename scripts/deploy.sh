#!/usr/bin/env bash
# Build-or-reuse IPK, reliably hot-reload onto $DEVICE (the ares-cli device
# profile name; override via the DEVICE env var or edit the default below).
#
# webOS gotcha: JS services with a TCP listener are ActivityManager-permanent
# AND ActivityManager may reuse a cached service module on `process.exit`,
# ignoring updated files on disk. The robust dev-loop is:
#   1. POST /kill on the running service (fast path if present)
#   2. ares-launch --close the app
#   3. ares-install --remove the package (busts ActivityManager's module cache)
#   4. ares-install the fresh IPK
#   5. ares-launch
# Skip the remove step with FAST=1 for a ~2s redeploy when you know the
# cache isn't holding stale code.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./scripts/_nvm.sh

DEVICE="${DEVICE:-mypanel}"
APP_ID="com.lg.app.signage.dev"
DEVICE_HOST="${DEVICE_HOST:-$(awk -F'"' '/"name":[[:space:]]*"'"$DEVICE"'"/,/"host"/ {if ($2=="host") print $4}' "$HOME/.webos/signage/novacom-devices.json" 2>/dev/null | head -1)}"
DEVICE_HOST="${DEVICE_HOST:-$DEVICE}"
HTTP_PORT="${HTTP_PORT:-9999}"

IPK="$(ls -t ./*.ipk 2>/dev/null | head -n1 || true)"
if [ -z "$IPK" ]; then
    echo "No IPK found — running build.sh first"
    ./scripts/build.sh
    IPK="$(ls -t ./*.ipk | head -n1)"
fi

if [ "${SKIP_KILL:-0}" != "1" ]; then
    echo "1/5 POST /kill to running service (if any)"
    curl -sS -m 2 -X POST "http://${DEVICE_HOST}:${HTTP_PORT}/kill" >/dev/null 2>&1 \
        && echo "    service killed" \
        || echo "    no response (fine — nothing to kill)"
fi

if [ "${FAST:-0}" != "1" ]; then
    echo "2/5 ares-launch --close $APP_ID"
    ares-launch --device "$DEVICE" --close "$APP_ID" 2>&1 | tail -1 || true

    echo "3/5 ares-install --remove $APP_ID  (busts ActivityManager module cache)"
    ares-install --device "$DEVICE" --remove "$APP_ID" 2>&1 | tail -1 || true

    # Short pause — ActivityManager has to finalize the uninstall before the next install.
    sleep 2
fi

echo "4/5 ares-install $IPK"
ares-install --device "$DEVICE" "$IPK"

echo "5/5 ares-launch $APP_ID"
ares-launch --device "$DEVICE" "$APP_ID"

echo
echo "Tip: verify with 'curl http://${DEVICE_HOST}:${HTTP_PORT}/health | jq .uptimeSeconds'"
echo "     (fresh install should show uptime <10s)"

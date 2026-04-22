#!/usr/bin/env bash
# Deploy IPK to DEVICE (default mypanel).
#
# Dev-reload gotcha: webOS JS services that hold a TCP listener are treated as
# a long-lived ActivityManager activity and do NOT die on ares-install or
# ares-launch --close. To pick up new service.js code, we first POST /kill to
# the running service — the new service.js has a /kill endpoint that calls
# process.exit(0). If the running service is older than that feature, do a
# one-time manual reboot of the panel. After that dev-loop is fast.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./scripts/_nvm.sh

DEVICE="${DEVICE:-mypanel}"
APP_ID="com.lg.app.signage.dev"
# Device host for the /kill probe — pulled from the ares device profile's host.
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
    echo "Asking running service on ${DEVICE_HOST}:${HTTP_PORT} to self-kill (for hot reload)"
    curl -sS -m 2 -X POST "http://${DEVICE_HOST}:${HTTP_PORT}/kill" >/dev/null 2>&1 || echo "  (no response — probably not running or too old for /kill)"
    # Give the process a moment to exit.
    sleep 1
fi

echo "Installing $IPK to device $DEVICE"
ares-install --device "$DEVICE" "$IPK"

echo "Launching $APP_ID on $DEVICE"
ares-launch --device "$DEVICE" "$APP_ID"

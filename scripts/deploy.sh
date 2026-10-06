#!/usr/bin/env bash
# Build-or-reuse IPK, reliably hot-reload onto a target panel. Targeting modes:
#   ./scripts/deploy.sh <host-or-ip>     # look up the paired ares-cli profile
#                                        # whose host matches (DNS resolved if needed)
#   DEVICE=<profile> ./scripts/deploy.sh # use a paired profile name directly
#   ./scripts/deploy.sh                  # fall back to DEVICE env or the default
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

APP_ID="com.lg.app.signage.dev"
HTTP_PORT="${HTTP_PORT:-9999}"
NOVACOM_DEVICES="$HOME/.webos/signage/novacom-devices.json"

# Pluck a JSON field out of novacom-devices.json without depending on jq.
# Args: <key-to-match> <value-to-match> <key-to-return>
# e.g. lookup_profile_field host 192.168.2.75 name  →  "lgwebos9"
lookup_profile_field() {
    local match_key="$1" match_val="$2" return_key="$3"
    [ -f "$NOVACOM_DEVICES" ] || return 0
    python3 - "$NOVACOM_DEVICES" "$match_key" "$match_val" "$return_key" <<'PY' 2>/dev/null || true
import json, sys
path, mk, mv, rk = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(path) as f:
    devices = json.load(f)
for d in devices:
    if d.get("profile") != "signage":
        continue
    if str(d.get(mk)) == mv and d.get(rk):
        print(d[rk])
        break
PY
}

if [ $# -ge 1 ] && [ -n "$1" ]; then
    TARGET_HOST="$1"
    DEVICE="$(lookup_profile_field host "$TARGET_HOST" name)"
    if [ -z "$DEVICE" ]; then
        RESOLVED_IP="$(getent hosts "$TARGET_HOST" 2>/dev/null | awk '{print $1; exit}')"
        if [ -n "$RESOLVED_IP" ] && [ "$RESOLVED_IP" != "$TARGET_HOST" ]; then
            DEVICE="$(lookup_profile_field host "$RESOLVED_IP" name)"
        fi
    fi
    if [ -z "$DEVICE" ]; then
        cat >&2 <<EOF
No paired ares-cli signage profile matches host '$TARGET_HOST'.

Pair the panel first (one-time, needs the dev-mode passphrase shown in the
panel's Developer Mode app):

    ares-setup-device

Then re-run: ./scripts/deploy.sh $TARGET_HOST
EOF
        exit 1
    fi
    DEVICE_HOST="$TARGET_HOST"
    echo "Targeting paired profile '$DEVICE' at $TARGET_HOST"
else
    DEVICE="${DEVICE:-mypanel}"
    DEVICE_HOST="${DEVICE_HOST:-$(lookup_profile_field name "$DEVICE" host)}"
    DEVICE_HOST="${DEVICE_HOST:-$DEVICE}"
fi

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

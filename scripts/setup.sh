#!/usr/bin/env bash
# Setup is a no-op today: service/ has no third-party npm deps.
# `webos-service` is provided by the device runtime, not published to npm,
# so we do not install it on the host. This script exists as a stable hook
# for when we add real host-installable deps later (e.g. build tools).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f service/package.json ] && grep -q '"dependencies"' service/package.json; then
    cd service
    npm install --omit=dev
else
    echo "setup.sh: no host-installable dependencies; skipping npm install"
fi

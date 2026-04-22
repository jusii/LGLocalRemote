#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. ./scripts/_nvm.sh

./scripts/setup.sh

rm -f ./*.ipk
ares-package app service

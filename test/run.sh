#!/usr/bin/env bash
# Runs extension-check.mjs in the Playwright image: there is no Node on the
# development machine, and the image carries the Chromium the check drives.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
docker run --rm -v "$HERE:/ext:ro" mcr.microsoft.com/playwright:v1.62.1-noble sh -c '
  cd /tmp && npm i --no-save --no-audit --no-fund playwright@1.62.1 >/dev/null 2>&1 &&
  cp /ext/test/extension-check.mjs /tmp/ && EXT_DIR=/ext node /tmp/extension-check.mjs'

#!/usr/bin/env bash
# Linux convenience wrapper; the cross-platform logic lives in e2e.mjs.
# On Windows/macOS run `node scripts/e2e.mjs` directly.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/e2e.mjs

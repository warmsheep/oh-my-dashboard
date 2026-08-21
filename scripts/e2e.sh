#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec xvfb-run -a npm run test:e2e

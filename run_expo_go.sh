#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/mobile"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required." >&2
  exit 1
fi
if [ ! -f node_modules/expo/bin/cli ]; then
  echo "Expo dependencies are missing. Run 'npm ci' in mobile/ first." >&2
  exit 1
fi

exec node node_modules/expo/bin/cli start --go --lan --port 8082 "$@"

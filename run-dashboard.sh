#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${TESLA_MCP_ENV_FILE:-$HOME/.config/tesla-battery-mcp/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Tesla Battery MCP configuration not found: $ENV_FILE" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
exec node "$ROOT_DIR/dist/dashboardServer.js"

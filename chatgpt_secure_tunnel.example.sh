#!/usr/bin/env bash
# Prerequisite: create a private OpenAI tunnel in Platform tunnel settings and
# export a runtime CONTROL_PLANE_API_KEY plus OPENAI_TUNNEL_ID. Do not place
# either value in this file, source control, or a ChatGPT MCP configuration.
set -euo pipefail

: "${CONTROL_PLANE_API_KEY:?Set the OpenAI tunnel runtime API key in the environment.}"
: "${OPENAI_TUNNEL_ID:?Set the private OpenAI tunnel ID in the environment.}"

TESLA_MCP_PATH="/absolute/path/to/tesla-battery-mcp"
tunnel-client init \
  --profile tesla-battery-local \
  --tunnel-id "$OPENAI_TUNNEL_ID" \
  --mcp-command "$TESLA_MCP_PATH/run-mcp.sh"
tunnel-client doctor --profile tesla-battery-local --explain
tunnel-client run --profile tesla-battery-local

# In ChatGPT, create a Developer Mode app and select Tunnel as the connection.
# Select this tunnel after associating it with the intended ChatGPT workspace.

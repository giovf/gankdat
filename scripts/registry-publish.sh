#!/bin/bash
# CI: publish server.json to the official MCP registry when its version is newer than the
# registry's latest. Needs MCP_REGISTRY_KEY (hex ed25519 seed of mcp-registry-key.pem).
set -euo pipefail
cd "$(dirname "$0")/.."
local_v=$(node -e "console.log(require('./server.json').version)")
live_v=$(curl -sf "https://registry.modelcontextprotocol.io/v0/servers/com.gankdat%2Fgankdat/versions/latest" | grep -oE '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
echo "server.json $local_v · registry $live_v"
[ "$local_v" = "$live_v" ] && { echo "registry up to date"; exit 0; }
[ -z "${MCP_REGISTRY_KEY:-}" ] && { echo "MCP_REGISTRY_KEY missing"; exit 1; }
url=$(curl -sf https://api.github.com/repos/modelcontextprotocol/registry/releases/latest | grep -oE '"browser_download_url": *"[^"]*publisher_linux_amd64\.tar\.gz"' | cut -d'"' -f4)
curl -sfL "$url" | tar xz mcp-publisher
./mcp-publisher login http --domain gankdat.com --private-key "$MCP_REGISTRY_KEY" >/dev/null
./mcp-publisher publish

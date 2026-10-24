#!/bin/bash
# CI: publish server.json to the official MCP registry when its version is newer than the
# registry's latest. Needs MCP_REGISTRY_KEY (hex ed25519 seed of mcp-registry-key.pem) and, for the
# releases API, GITHUB_TOKEN (the workflow passes it: an unauthenticated call from a shared
# hosted-runner IP shares GitHub's 60 requests/hour per IP and failed silently on 2026-10-23 — run 54
# exited 1 after the version line with no message, because `curl -sf | grep | cut` under
# `set -euo pipefail` says nothing; foundry `registry-publish-silent-exit`). Every step now names
# itself and the HTTP status when it fails, the registry read tells "unreachable" from "not
# published", the publisher's login and publish output is shown, and a failed publish retries once.
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY_URL="https://registry.modelcontextprotocol.io/v0/servers/com.gankdat%2Fgankdat/versions/latest"
RELEASES_URL="https://api.github.com/repos/modelcontextprotocol/registry/releases/latest"

fail() {
  echo "registry: FAILED at $1 — $2" >&2
  exit 1
}

# fetch <step> <url> [curl args…]: the body on stdout; a non-2xx status or a transport error fails
# the run naming the step, the status and the URL. Text bodies only (the body passes through a variable).
fetch() {
  local step=$1 url=$2 out status rc
  shift 2
  out=$(curl -sS -w '\n%{http_code}' "$@" "$url") || {
    rc=$?
    fail "$step" "curl exit $rc for $url"
  }
  status=${out##*$'\n'}
  [[ $status == 2* ]] || fail "$step" "HTTP $status for $url"
  printf '%s' "${out%$'\n'*}"
}

local_v=$(node -e "console.log(require('./server.json').version)")

# The registry read: 200 carries the latest version, 404 means nothing is published yet, anything
# else (5xx, a timeout) is "unreachable" — stop rather than publish against an empty comparison.
live_out=$(curl -sS -w '\n%{http_code}' "$REGISTRY_URL") || fail "registry read" "curl exit $? for $REGISTRY_URL"
live_status=${live_out##*$'\n'}
case $live_status in
  200) live_v=$(grep -oE '"version":"[^"]*"' <<<"${live_out%$'\n'*}" | head -1 | cut -d'"' -f4 || true) ;;
  404) live_v="" ;;
  *) fail "registry read" "HTTP $live_status for $REGISTRY_URL (unreachable, not 'not published')" ;;
esac
echo "server.json $local_v · registry ${live_v:-none (HTTP $live_status)}"
[ "$local_v" = "$live_v" ] && {
  echo "registry up to date"
  exit 0
}
[ -z "${MCP_REGISTRY_KEY:-}" ] && fail "key" "MCP_REGISTRY_KEY missing"

auth=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
else
  echo "registry: no GITHUB_TOKEN — the releases call is unauthenticated (60/h per runner IP)"
fi
release=$(fetch "releases API" "$RELEASES_URL" -H 'Accept: application/vnd.github+json' "${auth[@]}")
url=$(grep -oE '"browser_download_url": *"[^"]*publisher_linux_amd64\.tar\.gz"' <<<"$release" | cut -d'"' -f4 || true)
[ -n "$url" ] || fail "releases API" "no publisher_linux_amd64.tar.gz asset in the latest release"
echo "registry: publisher $url"
# The tarball is binary, so it goes to a file, not through fetch; the runner is ephemeral.
curl -sSfL -o mcp-publisher.tar.gz "$url" || fail "publisher download" "curl exit $? for $url"
tar xzf mcp-publisher.tar.gz mcp-publisher || fail "publisher download" "tar could not extract mcp-publisher"
echo "registry: login"
./mcp-publisher login http --domain gankdat.com --private-key "$MCP_REGISTRY_KEY" || fail "login" "mcp-publisher login exited $?"
echo "registry: publish $local_v"
if ! ./mcp-publisher publish; then
  echo "registry: publish failed — retrying once in 30 s"
  sleep 30
  ./mcp-publisher publish || fail "publish" "second attempt exited $?"
fi
echo "registry: published $local_v"

#!/usr/bin/env bash
# Build a .mcpb bundle for Claude Desktop.
#
# Usage: ./build.sh [version]
#   version: optional semver override (defaults to current manifest.json value)
#
# Produces: <repo-root>/build/netmon-mcp-<version>.mcpb
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT=$(git rev-parse --show-toplevel)

VERSION="${1:-}"
if [ -n "$VERSION" ]; then
  # Rewrite manifest + package.json version in place (restored in trap below).
  cp manifest.json manifest.json.bak
  cp package.json package.json.bak
  trap 'mv manifest.json.bak manifest.json; mv package.json.bak package.json' EXIT

  node -e "const f='manifest.json';const j=require('./'+f);j.version='$VERSION';require('fs').writeFileSync(f, JSON.stringify(j, null, 2)+'\n');"
  node -e "const f='package.json';const j=require('./'+f);j.version='$VERSION';require('fs').writeFileSync(f, JSON.stringify(j, null, 2)+'\n');"
fi

npm install --omit=dev --no-audit --no-fund

OUT_DIR="$REPO_ROOT/build"
mkdir -p "$OUT_DIR"
MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
OUT_FILE="$OUT_DIR/netmon-mcp-${MANIFEST_VERSION}.mcpb"

npx --yes @anthropic-ai/mcpb pack . "$OUT_FILE"
echo "Built: $OUT_FILE"

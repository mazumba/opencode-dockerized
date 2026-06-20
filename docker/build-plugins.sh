#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/plugins"
BASE="$SCRIPT_DIR/Dockerfile"
OUT="$SCRIPT_DIR/Dockerfile.generated"
MARKER="# {{plugins}}"

plugin_content=""
IFS=',' read -ra plugins <<< "${PLUGINS:-}"
for plugin in "${plugins[@]}"; do
    plugin="$(echo "$plugin" | tr -d '[:space:]')"
    [ -z "$plugin" ] && continue
    snippet="$PLUGINS_DIR/${plugin}.dockerfile"
    if [ ! -f "$snippet" ]; then
        echo "Error: plugin '$plugin' not found (expected $snippet)" >&2
        exit 1
    fi
    plugin_content="${plugin_content}"$'\n'"$(cat "$snippet")"
done

while IFS= read -r line; do
    if [ "$line" = "$MARKER" ]; then
        echo "$plugin_content"
    else
        echo "$line"
    fi
done < "$BASE" > "$OUT"

OPENCODE_DOCKERFILE=Dockerfile.generated \
    docker compose -f "$(dirname "$SCRIPT_DIR")/compose.yml" build --no-cache

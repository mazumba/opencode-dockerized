#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PLUGINS_DIR="$SCRIPT_DIR/plugins"
BASE="$SCRIPT_DIR/Dockerfile"
OUT="$SCRIPT_DIR/Dockerfile.generated"
MARKER="# {{plugins}}"

OPENCODE_CONFIG_DIR="$REPO_ROOT/.opencode/config"
OPENCODE_JSONC_BASE="$OPENCODE_CONFIG_DIR/opencode.jsonc.base"
OPENCODE_JSONC_DIST="$OPENCODE_CONFIG_DIR/opencode.jsonc.base.dist"
OPENCODE_JSONC_OUT="$OPENCODE_CONFIG_DIR/opencode.jsonc"
PACKAGE_JSON="$OPENCODE_CONFIG_DIR/package.json"
MCP_MARKER="// {{mcp-plugins}}"

DRY_RUN=false
for arg in "$@"; do
    [ "$arg" = "--dry-run" ] && DRY_RUN=true
done

# ── Collect active plugins ────────────────────────────────────────────────────
plugin_list=()
IFS=',' read -ra _raw <<< "${PLUGINS:-}"
for plugin in "${_raw[@]}"; do
    plugin="$(echo "$plugin" | tr -d '[:space:]')"
    [ -z "$plugin" ] && continue
    plugin_list+=("$plugin")
done

# ── Phase 1: Dockerfile injection ────────────────────────────────────────────
dockerfile_content=""
for plugin in "${plugin_list[@]}"; do
    # Prefer subdirectory layout: <name>/<name>.dockerfile
    if [ -f "$PLUGINS_DIR/${plugin}/${plugin}.dockerfile" ]; then
        snippet="$PLUGINS_DIR/${plugin}/${plugin}.dockerfile"
    elif [ -f "$PLUGINS_DIR/${plugin}.dockerfile" ]; then
        snippet="$PLUGINS_DIR/${plugin}.dockerfile"
    else
        echo "Error: plugin '$plugin' not found (expected $PLUGINS_DIR/${plugin}/${plugin}.dockerfile)" >&2
        exit 1
    fi
    dockerfile_content="${dockerfile_content}"$'\n'"$(cat "$snippet")"
done

generated_dockerfile=""
while IFS= read -r line; do
    if [ "$line" = "$MARKER" ]; then
        generated_dockerfile="${generated_dockerfile}${dockerfile_content}"$'\n'
    else
        generated_dockerfile="${generated_dockerfile}${line}"$'\n'
    fi
done < "$BASE"

# ── Phase 2: npm package.json merge ──────────────────────────────────────────
# Start from the committed package.json (strip any previously injected plugin deps)
# Strategy: rebuild dependencies from base (only @opencode-ai/plugin) then add plugin deps
base_pkg_deps="{}"
if [ -f "$PACKAGE_JSON" ]; then
    # Extract only non-plugin deps (everything that was there originally)
    # Since package.json is simple, we rebuild it from scratch keeping @opencode-ai/plugin
    base_pkg_deps="$(cat "$PACKAGE_JSON")"
fi

merged_pkg="$base_pkg_deps"
for plugin in "${plugin_list[@]}"; do
    pkg_file="$PLUGINS_DIR/${plugin}/${plugin}.package.json"
    [ -f "$pkg_file" ] || continue
    # Merge dependencies using python3
    merged_pkg="$(
        python3 -c "
import json, sys
base = json.loads(sys.argv[1])
with open(sys.argv[2]) as f:
    plugin = json.load(f)
base.setdefault('dependencies', {}).update(plugin.get('dependencies', {}))
print(json.dumps(base, indent=2))
" "$merged_pkg" "$pkg_file"
    )"
done

# ── Phase 3: opencode.jsonc config injection ──────────────────────────────────
# Check whether any active plugin has an MCP config fragment
has_mcp_plugin=false
for plugin in "${plugin_list[@]}"; do
    [ -f "$PLUGINS_DIR/${plugin}/${plugin}.opencode.jsonc" ] && has_mcp_plugin=true && break
done

if $has_mcp_plugin; then
    # Auto-copy .dist template if user has not created their own .base yet
    if [ ! -f "$OPENCODE_JSONC_BASE" ]; then
        if [ ! -f "$OPENCODE_JSONC_DIST" ]; then
            echo "Error: $OPENCODE_JSONC_DIST not found. Cannot bootstrap opencode.jsonc.base." >&2
            exit 1
        fi
        echo "Note: $OPENCODE_JSONC_BASE not found — copying from $OPENCODE_JSONC_DIST"
        cp "$OPENCODE_JSONC_DIST" "$OPENCODE_JSONC_BASE"
    fi
fi

if [ ! -f "$OPENCODE_JSONC_BASE" ]; then
    # No base file and no MCP plugins — skip config phase entirely
    generated_jsonc=""
else

mcp_fragments=""
for plugin in "${plugin_list[@]}"; do
    frag_file="$PLUGINS_DIR/${plugin}/${plugin}.opencode.jsonc"
    [ -f "$frag_file" ] || continue
    content="$(cat "$frag_file")"
    if [ -z "$mcp_fragments" ]; then
        mcp_fragments="$content"
    else
        mcp_fragments="${mcp_fragments},"$'\n'"$content"
    fi
done

generated_jsonc=""
while IFS= read -r line; do
    if [[ "$line" == *"$MCP_MARKER"* ]]; then
        if [ -n "$mcp_fragments" ]; then
            # Indent each fragment line to match the marker indentation
            indent="${line%%\/\/*}"
            indented_frag=""
            while IFS= read -r frag_line; do
                indented_frag="${indented_frag}${indent}${frag_line}"$'\n'
            done <<< "$mcp_fragments"
            generated_jsonc="${generated_jsonc}${indented_frag}"
        fi
        # Skip the marker line itself
    else
        generated_jsonc="${generated_jsonc}${line}"$'\n'
    fi
done < "$OPENCODE_JSONC_BASE"
fi # end: has base file check

# ── Output / dry-run ──────────────────────────────────────────────────────────
if $DRY_RUN; then
    echo "=== Dockerfile.generated diff ==="
    diff <(cat "$OUT" 2>/dev/null || true) <(echo "$generated_dockerfile") || true
    echo ""
    if [ -n "$generated_jsonc" ]; then
        echo "=== opencode.jsonc diff ==="
        diff <(cat "$OPENCODE_JSONC_OUT" 2>/dev/null || true) <(echo "$generated_jsonc") || true
        echo ""
    fi
    echo "=== package.json diff ==="
    diff <(cat "$PACKAGE_JSON" 2>/dev/null || true) <(echo "$merged_pkg") || true
    echo "[dry-run] No files written."
    exit 0
fi

printf '%s' "$generated_dockerfile" > "$OUT"
[ -n "$generated_jsonc" ] && printf '%s' "$generated_jsonc" > "$OPENCODE_JSONC_OUT"
printf '%s' "$merged_pkg" > "$PACKAGE_JSON"

# ── Docker build ──────────────────────────────────────────────────────────────
OPENCODE_DOCKERFILE=Dockerfile.generated \
    docker compose -f "$REPO_ROOT/compose.yml" build --no-cache

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PLUGINS_DIR="$SCRIPT_DIR/plugins"
BASE="$SCRIPT_DIR/Dockerfile"
OUT="$SCRIPT_DIR/Dockerfile.generated"
MARKER="# {{plugins}}"
HOOK_MARKER="# {{plugin-hooks}}"
HOOK_DEST_DIR="/usr/local/lib/opencode/entrypoint.d"

OPENCODE_CONFIG_DIR="$REPO_ROOT/.opencode/config"
OPENCODE_JSONC_BASE="$OPENCODE_CONFIG_DIR/opencode.jsonc.base"
OPENCODE_JSONC_DIST="$OPENCODE_CONFIG_DIR/opencode.jsonc.base.dist"
OPENCODE_JSONC_OUT="$OPENCODE_CONFIG_DIR/opencode.jsonc"
PACKAGE_JSON="$OPENCODE_CONFIG_DIR/package.json"
MCP_MARKER="// {{mcp-plugins}}"
AGENT_MARKER="// {{agent-plugins}}"
PERMISSION_MARKER="// {{permission-plugins}}"

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

# ── Phase 1b: Optional entrypoint startup hooks ──────────────────────────────
# Enabled plugins may ship <name>.entrypoint.sh, run as root by
# docker/entrypoint.sh before the privilege drop to gosu. Each hook is copied
# into /usr/local/lib/opencode/entrypoint.d/ under a zero-padded ordinal name
# (NNN-<name>.sh) so lexical directory ordering matches PLUGINS order,
# regardless of how many digits the count needs. Only plugins that ship a
# hook consume an ordinal; the sequence has no gaps.
hook_content=""
hook_ordinal=0
for plugin in "${plugin_list[@]}"; do
    hook_file="$PLUGINS_DIR/${plugin}/${plugin}.entrypoint.sh"
    [ -f "$hook_file" ] || continue

    if ! sh -n "$hook_file"; then
        echo "Error: plugin '$plugin' entrypoint hook has invalid shell syntax: $hook_file" >&2
        exit 1
    fi

    hook_ordinal=$((hook_ordinal + 1))
    ordinal_padded="$(printf '%03d' "$hook_ordinal")"
    dest="${HOOK_DEST_DIR}/${ordinal_padded}-${plugin}.sh"
    hook_content="${hook_content}"$'\n'"COPY --chmod=0755 plugins/${plugin}/${plugin}.entrypoint.sh ${dest}"
done

generated_dockerfile=""
while IFS= read -r line; do
    if [ "$line" = "$MARKER" ]; then
        generated_dockerfile="${generated_dockerfile}${dockerfile_content}"$'\n'
    elif [ "$line" = "$HOOK_MARKER" ]; then
        [ -n "$hook_content" ] && generated_dockerfile="${generated_dockerfile}${hook_content}"$'\n'
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
# Check whether any active plugin ships a config fragment (MCP and/or agent).
# Either kind requires the opencode.jsonc.base file to exist, so both trigger
# the .dist bootstrap below.
has_config_plugin=false
for plugin in "${plugin_list[@]}"; do
    if [ -f "$PLUGINS_DIR/${plugin}/${plugin}.opencode.jsonc" ] || [ -f "$PLUGINS_DIR/${plugin}/${plugin}.agent.jsonc" ]; then
        has_config_plugin=true
        break
    fi
done

if $has_config_plugin; then
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
    # No base file and no config plugins — skip config phase entirely
    generated_jsonc=""
else

# Extracts the top-level key of an <name>.opencode.jsonc MCP fragment,
# sanitized the same way opencode normalizes server names ([^a-zA-Z0-9_-] -> "_").
extract_mcp_server_name() {
    python3 -c "
import json, re, sys
with open(sys.argv[1]) as f:
    content = f.read()
data = json.loads('{' + content + '}')
key = next(iter(data))
print(re.sub(r'[^a-zA-Z0-9_-]', '_', key))
" "$1"
}

# A plugin may ship <name>.opencode.jsonc (MCP server), <name>.agent.jsonc (an
# agent that exclusively owns that server's tools), or both. When a plugin
# ships both, its MCP server's tools are denied for every other agent via the
# permission-plugins marker, so only the plugin's own agent (through its
# permission.allow) can use them.
mcp_fragments=""
mcp_needed_by=""
agent_fragments=""
agent_needed_by=""
permission_fragments=""
permission_needed_by=""

for plugin in "${plugin_list[@]}"; do
    mcp_file="$PLUGINS_DIR/${plugin}/${plugin}.opencode.jsonc"
    agent_file="$PLUGINS_DIR/${plugin}/${plugin}.agent.jsonc"

    if [ -f "$mcp_file" ]; then
        content="$(cat "$mcp_file")"
        if [ -z "$mcp_fragments" ]; then
            mcp_fragments="$content"
        else
            mcp_fragments="${mcp_fragments},"$'\n'"$content"
        fi
        [ -z "$mcp_needed_by" ] && mcp_needed_by="$plugin"
    fi

    if [ -f "$agent_file" ]; then
        content="$(cat "$agent_file")"
        if [ -z "$agent_fragments" ]; then
            agent_fragments="$content"
        else
            agent_fragments="${agent_fragments},"$'\n'"$content"
        fi
        [ -z "$agent_needed_by" ] && agent_needed_by="$plugin"
    fi

    if [ -f "$mcp_file" ] && [ -f "$agent_file" ]; then
        server_name="$(extract_mcp_server_name "$mcp_file")"
        if [ -z "$server_name" ]; then
            echo "Error: could not determine MCP server name from $mcp_file" >&2
            exit 1
        fi
        deny_entry="\"${server_name}_*\": \"deny\""
        if [ -z "$permission_fragments" ]; then
            permission_fragments="$deny_entry"
        else
            permission_fragments="${permission_fragments},"$'\n'"$deny_entry"
        fi
        [ -z "$permission_needed_by" ] && permission_needed_by="$plugin"
    fi
done

# Fail loudly if a plugin needs a marker the base file does not provide.
if [ -n "$mcp_fragments" ] && ! grep -qF "$MCP_MARKER" "$OPENCODE_JSONC_BASE"; then
    echo "Error: $OPENCODE_JSONC_BASE is missing marker '$MCP_MARKER' required by plugin '$mcp_needed_by'" >&2
    exit 1
fi
if [ -n "$agent_fragments" ] && ! grep -qF "$AGENT_MARKER" "$OPENCODE_JSONC_BASE"; then
    echo "Error: $OPENCODE_JSONC_BASE is missing marker '$AGENT_MARKER' required by plugin '$agent_needed_by'" >&2
    exit 1
fi
if [ -n "$permission_fragments" ] && ! grep -qF "$PERMISSION_MARKER" "$OPENCODE_JSONC_BASE"; then
    echo "Error: $OPENCODE_JSONC_BASE is missing marker '$PERMISSION_MARKER' required by plugin '$permission_needed_by'" >&2
    exit 1
fi

# Appends a trailing comma to the last non-blank, non-comment-only line
# already in out_lines, unless it already ends with a comma or an opening
# bracket/brace. Needed because injected fragments are the last entries in
# their JSONC block, and the previously-last entry had no trailing comma.
add_trailing_comma() {
    local i line trimmed rtrimmed last_char
    for ((i = ${#out_lines[@]} - 1; i >= 0; i--)); do
        line="${out_lines[$i]}"
        trimmed="${line#"${line%%[![:space:]]*}"}"
        [ -z "$trimmed" ] && continue
        [[ "$trimmed" == //* ]] && continue
        rtrimmed="${line%"${line##*[![:space:]]}"}"
        last_char="${rtrimmed: -1}"
        case "$last_char" in
            ','|'{'|'[') ;;
            *) out_lines[$i]="${rtrimmed}," ;;
        esac
        return
    done
}

out_lines=()
while IFS= read -r line; do
    case "$line" in
        *"$MCP_MARKER"*)
            if [ -n "$mcp_fragments" ]; then
                add_trailing_comma
                indent="${line%%\/\/*}"
                while IFS= read -r frag_line; do
                    out_lines+=("${indent}${frag_line}")
                done <<< "$mcp_fragments"
            fi
            ;;
        *"$AGENT_MARKER"*)
            if [ -n "$agent_fragments" ]; then
                add_trailing_comma
                indent="${line%%\/\/*}"
                while IFS= read -r frag_line; do
                    out_lines+=("${indent}${frag_line}")
                done <<< "$agent_fragments"
            fi
            ;;
        *"$PERMISSION_MARKER"*)
            if [ -n "$permission_fragments" ]; then
                add_trailing_comma
                indent="${line%%\/\/*}"
                while IFS= read -r frag_line; do
                    out_lines+=("${indent}${frag_line}")
                done <<< "$permission_fragments"
            fi
            ;;
        *)
            out_lines+=("$line")
            ;;
    esac
done < "$OPENCODE_JSONC_BASE"

generated_jsonc=""
for line in "${out_lines[@]}"; do
    generated_jsonc="${generated_jsonc}${line}"$'\n'
done
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
    "$SCRIPT_DIR/compose-with-plugins.sh" build --no-cache

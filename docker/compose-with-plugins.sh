#!/usr/bin/env bash
# Thin wrapper around `docker compose` that layers plugin Compose fragments
# on top of the repo's compose.yml, driven by the same PLUGINS convention as
# docker/build-plugins.sh.
#
# Usage: docker/compose-with-plugins.sh <docker compose args...>
#   PLUGINS=image,midi docker/compose-with-plugins.sh up -d --wait opencode
#
# PLUGINS is read from the environment (the Makefile exports it from .env;
# it can also be set explicitly when invoking this script directly).
#
# Fragment convention: docker/plugins/<name>/<name>.compose.yml (optional).
# Fragments are appended via repeated `-f` in PLUGINS order; Compose itself
# performs the merge/validation (no merged file is generated or committed).
#
# A plugin selected via PLUGINS must have a <name>.dockerfile, exactly like
# build-plugins.sh requires — this keeps both entry points consistent about
# what counts as a "valid" plugin name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PLUGINS_DIR="$SCRIPT_DIR/plugins"
COMPOSE_BASE="$REPO_ROOT/compose.yml"
COMPOSE_OVERRIDE="$REPO_ROOT/compose.override.yml"

# ── Collect active plugins (parsing kept consistent with build-plugins.sh) ──
plugin_list=()
IFS=',' read -ra _raw <<< "${PLUGINS:-}"
for plugin in "${_raw[@]}"; do
    plugin="$(echo "$plugin" | tr -d '[:space:]')"
    [ -z "$plugin" ] && continue
    plugin_list+=("$plugin")
done

compose_args=(-f "$COMPOSE_BASE")

for plugin in "${plugin_list[@]}"; do
    # Every selected plugin must provide a dockerfile — same requirement as
    # build-plugins.sh, even though this wrapper only cares about its
    # optional compose fragment.
    if [ ! -f "$PLUGINS_DIR/${plugin}/${plugin}.dockerfile" ] && [ ! -f "$PLUGINS_DIR/${plugin}.dockerfile" ]; then
        echo "Error: plugin '$plugin' not found (expected $PLUGINS_DIR/${plugin}/${plugin}.dockerfile)" >&2
        exit 1
    fi

    fragment="$PLUGINS_DIR/${plugin}/${plugin}.compose.yml"
    if [ -f "$fragment" ]; then
        compose_args+=(-f "$fragment")
    fi
done

# compose.override.yml is gitignored, local-only, and normally auto-merged by
# `docker compose` when no -f flags are given. Since we pass explicit -f
# flags for plugin fragments, we must re-add it explicitly, last, so local
# overrides still win over everything else.
[ -f "$COMPOSE_OVERRIDE" ] && compose_args+=(-f "$COMPOSE_OVERRIDE")

exec docker compose "${compose_args[@]}" "$@"

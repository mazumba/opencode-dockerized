#!/usr/bin/env bash
# Checks that compose.override.yml.dist loads through compose-with-plugins.sh
# with and without the kanban plugin. Needs docker compose; builds nothing.
#
#   docker/test-compose-plugins.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# The wrapper resolves compose files relative to its own location, so run a copy
# whose override is the template rather than the user's local file.
mkdir -p "$WORK/docker"
cp "$REPO_ROOT/compose.yml" "$WORK/compose.yml"
cp "$REPO_ROOT/compose.override.yml.dist" "$WORK/compose.override.yml"
cp "$REPO_ROOT/docker/compose-with-plugins.sh" "$WORK/docker/"
cp -R "$REPO_ROOT/docker/plugins" "$WORK/docker/plugins"

# Placeholder values for variables compose.yml and kanban.compose.yml interpolate.
export USER_UID=1000 USER_GID=1000 KANBAN_PROJECTS_ROOT=/full/path/to/my/projects

for plugins in "" "kanban"; do
    label="PLUGINS=${plugins:-<none>}"
    PLUGINS="$plugins" "$WORK/docker/compose-with-plugins.sh" config --quiet ||
        fail "$label: compose project is invalid"
    PLUGINS="$plugins" "$WORK/docker/compose-with-plugins.sh" config --services >"$WORK/services"
    grep -qx opencode "$WORK/services" || fail "$label: opencode service missing"
    grep -qx kanban-poller "$WORK/services" && fail "$label: kanban-poller active without its profile"
    echo "ok: $label"
done

PLUGINS=kanban "$WORK/docker/compose-with-plugins.sh" --profile kanban-poller config --format json >"$WORK/kanban.json"
python3 - "$WORK/kanban.json" <<'PY' || fail "PLUGINS=kanban: kanban-poller lost its image or projects mount"
import json, sys
service = json.load(open(sys.argv[1]))["services"]["kanban-poller"]
assert service.get("image"), "image"
assert any(v.get("target") == "/full/path/to/my/projects" for v in service.get("volumes", [])), "mount"
PY
echo "ok: PLUGINS=kanban with profile keeps the poller image and projects mount"

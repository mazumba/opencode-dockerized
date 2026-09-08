#!/bin/sh
set -e

# Grant the non-root opencode user access to the Docker socket by adding it
# to the group that owns the socket — without mutating the socket's permissions
# on the host.
#
# macOS Docker Desktop: socket is owned by root:root (GID 0)  → opencode joins group root
# Linux:                socket is owned by root:docker (GID varies) → opencode joins that group
if [ -S /var/run/docker.sock ]; then
    SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
    if ! getent group "${SOCK_GID}" > /dev/null 2>&1; then
        groupadd -g "${SOCK_GID}" docker-host
    fi
    usermod -aG "${SOCK_GID}" opencode
fi

# Run plugin-provided startup hooks, if any, as root, in lexical order.
# Hooks are optional POSIX shell scripts installed at build time by
# docker/build-plugins.sh under /usr/local/lib/opencode/entrypoint.d/ (see
# docker/plugins/plugin.dockerfile.dist for the naming convention). This
# script remains plugin-agnostic: it only knows the directory convention.
#
# Each hook runs as a separate `sh` process. `set -e` above means any hook
# that exits non-zero aborts container startup before gosu drops privileges.
HOOK_DIR=/usr/local/lib/opencode/entrypoint.d
if [ -d "$HOOK_DIR" ]; then
    for hook in "$HOOK_DIR"/*.sh; do
        [ -f "$hook" ] || continue
        echo "entrypoint: running startup hook $(basename "$hook")"
        sh "$hook"
    done
fi

# Drop privileges and exec the real command as the opencode user.
# gosu reads /etc/group at exec time, so the new group membership is picked up.
exec gosu opencode "$@"


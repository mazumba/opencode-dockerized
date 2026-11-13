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

# Log the opencode user in to a private Docker registry. The login goes through
# the host daemon, so the host daemon must trust the registry's CA itself (see
# README "Corporate CA and private registry"). A failed login only warns: the
# registry may be unreachable off-VPN, and opencode is still usable without it.
if [ -n "${DOCKER_REGISTRY:-}" ]; then
    if [ -z "${DOCKER_REGISTRY_USER:-}" ] || [ -z "${DOCKER_REGISTRY_PASSWORD:-}" ]; then
        echo "entrypoint: DOCKER_REGISTRY is set but DOCKER_REGISTRY_USER or DOCKER_REGISTRY_PASSWORD is empty" >&2
        exit 1
    fi
    if printf '%s' "$DOCKER_REGISTRY_PASSWORD" \
        | gosu opencode docker login "$DOCKER_REGISTRY" --username "$DOCKER_REGISTRY_USER" --password-stdin > /dev/null; then
        echo "entrypoint: logged in to $DOCKER_REGISTRY"
    else
        echo "entrypoint: WARNING: docker login to $DOCKER_REGISTRY failed; image pulls from it will fail" >&2
    fi
fi
# Keep the password out of the opencode process environment. It still ends up
# in ~/.docker/config.json, readable by the agent: use a read-only account.
unset DOCKER_REGISTRY_PASSWORD

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


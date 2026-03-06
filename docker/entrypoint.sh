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

# Drop privileges and exec the real command as the opencode user.
# gosu reads /etc/group at exec time, so the new group membership is picked up.
exec gosu opencode "$@"


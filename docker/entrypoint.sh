#!/bin/sh
set -e

# The Docker socket may be owned by root:root 0660 (macOS Docker Desktop)
# or root:docker 0660 (Linux). Widening to 0666 at startup lets the
# non-root opencode user talk to the daemon without needing a matching GID.
if [ -S /var/run/docker.sock ]; then
    chmod 666 /var/run/docker.sock
fi

# Drop privileges and exec the real command as the opencode user.
exec gosu opencode "$@"


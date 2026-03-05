# opencode-dockerized
Run opencode inside a docker container with the docker cli installed and mounted socket.

## Usage

```sh
# Build and run (recommended – DOCKER_GID is detected automatically)
make opencode-build
make opencode-run

# Tear down
make opencode-down
```

## Docker socket access (`DOCKER_GID`)

The container needs to talk to the host Docker socket (`/var/run/docker.sock`).
To avoid permission errors the group inside the container must match the GID that
owns the socket on **your** host:

| Host OS | Typical socket GID |
|---------|--------------------|
| macOS (Docker Desktop) | `1` (`daemon`) |
| Linux (Docker Engine) | `999` or varies |

The `Makefile` detects the correct GID automatically:

```makefile
DOCKER_GID ?= $(shell stat -c '%g' /var/run/docker.sock 2>/dev/null \
                    || stat -f '%g' /var/run/docker.sock 2>/dev/null \
                    || echo 1)
export DOCKER_GID
```

If you build or run **without** the Makefile, export the variable yourself first:

```sh
# macOS
export DOCKER_GID=$(stat -f '%g' /var/run/docker.sock)

# Linux
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)

docker compose build --no-cache
docker compose up -d
```


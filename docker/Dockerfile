FROM debian:bookworm-slim

ARG DOCKER_GID=1001
ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    make \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI only (no daemon)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user matching the host user's UID/GID
RUN groupadd -g ${USER_GID} opencode \
    && useradd -m -u ${USER_UID} -g opencode -s /bin/bash opencode

# Create docker group with the host's GID so the socket is accessible
RUN groupadd -g ${DOCKER_GID} docker-host 2>/dev/null || true \
    && usermod -aG docker-host opencode 2>/dev/null || true

# Install opencode as the opencode user
USER opencode
RUN curl -fsSL https://opencode.ai/install | bash \
    && mkdir -p /home/opencode/.local/state/opencode \
    && mkdir -p /home/opencode/.local/share/opencode \
    && mkdir -p /home/opencode/.config/opencode

CMD ["/home/opencode/.opencode/bin/opencode", "web", "--hostname", "0.0.0.0"]

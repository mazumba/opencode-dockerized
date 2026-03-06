FROM debian:bookworm-slim

ARG USER_UID=1000
ARG USER_GID=1000

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    gosu \
    make \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install Docker CLI only (no daemon)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user "opencode" matching the host user's UID/GID
RUN if ! getent group ${USER_GID} > /dev/null 2>&1; then \
        groupadd -g ${USER_GID} opencode; \
    fi \
    && useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash opencode

# Install opencode as the opencode user
USER opencode
RUN curl -fsSL https://opencode.ai/install | bash \
    && mkdir -p /home/opencode/.local/state/opencode \
    && mkdir -p /home/opencode/.local/share/opencode \
    && mkdir -p /home/opencode/.config/opencode

# Switch back to root so the entrypoint can adjust group membership before dropping privileges
USER root
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/home/opencode/.opencode/bin/opencode", "web", "--hostname", "0.0.0.0"]

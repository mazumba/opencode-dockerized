FROM debian:12.14-slim

ARG USER_UID=1000
ARG USER_GID=1000
ARG OPENCODE_VERSION=

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    gosu \
    make \
    python3 \
    poppler-utils \
    ripgrep

RUN rm -rf /var/lib/apt/lists/*

# Install Docker CLI only (no daemon)
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
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

USER opencode
RUN if [ -n "${OPENCODE_VERSION}" ]; then \
        curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}"; \
    else \
        curl -fsSL https://opencode.ai/install | bash -s; \
    fi \
    && mkdir -p /home/opencode/.local/state/opencode \
    && mkdir -p /home/opencode/.local/share/opencode \
    && mkdir -p /home/opencode/.config/opencode

USER root
# injection marker for plugin system dependencies (apt or pip). See docker/plugins/plugin.dockerfile.dist for details.
# {{plugins}}

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/home/opencode/.opencode/bin/opencode", "web", "--hostname", "0.0.0.0"]

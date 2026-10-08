FROM debian:12.14-slim

ARG USER_UID=1000
ARG USER_GID=1000
ARG OPENCODE_VERSION=
ARG OH_MY_OPENCODE_SLIM_VERSION=

RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    git \
    gosu \
    make \
    python3 \
    poppler-utils \
    ripgrep \
    unzip

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
# Resolve "latest" ourselves via the github.com release redirect: the
# installer's own lookup uses the GitHub API, which is rate-limited to 60
# anonymous requests per hour per IP and then fails with a vague error.
RUN set -eu; \
    version="${OPENCODE_VERSION}"; \
    if [ -z "$version" ]; then \
        version=$(curl -fsSI -o /dev/null -w '%{redirect_url}' \
            https://github.com/anomalyco/opencode/releases/latest | sed -n 's#.*/tag/v##p'); \
        [ -n "$version" ] || { echo "could not resolve latest opencode version; set OPENCODE_VERSION in .env" >&2; exit 1; }; \
    fi; \
    echo "installing opencode $version"; \
    curl -fsSL https://opencode.ai/install | bash -s -- --version "$version" --no-modify-path \
    && mkdir -p /home/opencode/.local/state/opencode \
    && mkdir -p /home/opencode/.local/share/opencode \
    && mkdir -p /home/opencode/.config/opencode

USER root
# injection marker for plugin system dependencies (apt or pip). See docker/plugins/plugin.dockerfile.dist for details.
# {{plugins}}

USER opencode
RUN curl -fsSL https://bun.sh/install | bash
RUN if [ -n "${OH_MY_OPENCODE_SLIM_VERSION}" ]; then \
        bun x oh-my-opencode-slim@${OH_MY_OPENCODE_SLIM_VERSION} install; \
    else \
        bun x oh-my-opencode-slim@latest install; \
    fi

USER root
# Directory for plugin-provided startup hooks. Always created so entrypoint.sh
# can safely iterate it even when no plugin ships a hook.
RUN mkdir -p /usr/local/lib/opencode/entrypoint.d

# injection marker for plugin startup hooks (optional). See docker/plugins/plugin.dockerfile.dist for details.
# {{plugin-hooks}}

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/home/opencode/.opencode/bin/opencode", "web", "--hostname", "0.0.0.0"]

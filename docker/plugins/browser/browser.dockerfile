# Plugin: browser
# Playwright Chromium runtime system dependencies (apt packages for headless Chromium)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install bun runtime system-wide (needed at build time for chromium install and at runtime for the MCP server)
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash

# Install Chromium browser binary into the opencode user's home directory
USER opencode
RUN bun x playwright@1.60.0-alpha-1777566615000 install chromium
USER root

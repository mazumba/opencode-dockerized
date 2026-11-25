# Plugin: mention
# Bun comes from the base image; gh comes from the github plugin.
COPY plugins/mention/poller/ /usr/local/lib/opencode/mention-poller/
# The OpenCode V2 API client (@opencode/client), pinned by bun.lock.
RUN cd /usr/local/lib/opencode/mention-poller && bun install --frozen-lockfile --production

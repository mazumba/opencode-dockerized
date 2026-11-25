# Plugin: kanban
# Needs no packages of its own; jq and gh come from the linear and github plugins (see kanban.requires).

# Poller: runs the kanban commands unattended (see README "Kanban plugin").
# Executed by Bun from the base image.
COPY plugins/kanban/poller/ /usr/local/lib/opencode/kanban-poller/
# The OpenCode V2 API client (@opencode/client), pinned by bun.lock.
RUN cd /usr/local/lib/opencode/kanban-poller && bun install --frozen-lockfile --production

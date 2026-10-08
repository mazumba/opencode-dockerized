# Plugin: kanban
# Needs no packages of its own; jq and gh come from the linear and github plugins (see kanban.requires).

# Poller: runs the kanban commands unattended (see README "Kanban plugin").
# Executed by Bun from the base image, so it needs no dependencies.
COPY plugins/kanban/poller/ /usr/local/lib/opencode/kanban-poller/

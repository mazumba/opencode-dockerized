#!/bin/sh
# Plugin: linear — startup hook (runs as root, before privilege drop)
#
# Verifies LINEAR_API_KEY against the Linear GraphQL API by querying the
# viewer and organization. Personal API keys are sent without a "Bearer"
# prefix on this API. The key is passed to curl on stdin so it does not
# appear in the process list, and it is never printed.
#
# Fail-closed: a missing or rejected key aborts container startup (the caller
# runs this under `set -e`).
set -e

[ -n "${LINEAR_API_KEY:-}" ] || {
    echo "linear plugin: LINEAR_API_KEY is not set" >&2
    exit 1
}

response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

# `|| status=000` keeps a curl transport failure from skipping the message below.
status=$(printf 'Authorization: %s\n' "$LINEAR_API_KEY" | curl -sS --max-time 15 \
    -H @- \
    -H "Content-Type: application/json" \
    -d '{"query":"{ viewer { name } organization { name } }"}' \
    -o "$response_file" -w '%{http_code}' \
    https://api.linear.app/graphql) || status=000

viewer_name=$(jq -r '.data.viewer.name // empty' "$response_file" 2>/dev/null || true)
org_name=$(jq -r '.data.organization.name // empty' "$response_file" 2>/dev/null || true)

if [ "$status" != "200" ] || [ -z "$viewer_name" ]; then
    error_message=$(jq -r '.errors[0].message // empty' "$response_file" 2>/dev/null || true)
    echo "linear plugin: API key check failed (HTTP $status)${error_message:+: $error_message}" >&2
    exit 1
fi

echo "linear plugin: ready ($viewer_name @ $org_name)"

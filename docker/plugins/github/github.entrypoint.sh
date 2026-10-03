# Plugin: github — startup hook (runs as root, before privilege drop)
#
# Mints a short-lived App JWT (see gh-app-token --jwt) to discover the App's
# slug and, unless GH_APP_INSTALLATION_ID is set, its installation — this
# only works automatically when the App is installed on exactly one
# account, per README "GitHub plugin". It then resolves the bot user's
# numeric id (needed for the commit-attribution noreply email) and writes
# everything to $CACHE_DIR/installation.json for gh-app-token to read.
#
# Finally it configures git, as the opencode user, to authenticate through
# git-credential-github-app and to attribute commits to the bot account.
#
# Fail-closed: any discovery, resolution, or verification failure aborts
# container startup (the caller runs this under `set -e`) rather than
# silently falling back to unauthenticated git.
set -e

GH_APP_SCRIPTS=/usr/local/lib/opencode/github
CACHE_DIR=/home/opencode/.cache/gh-app
CONFIG_FILE="$CACHE_DIR/installation.json"

[ -n "${GH_APP_ID:-}" ] || {
    echo "github plugin: GH_APP_ID is not set" >&2
    exit 1
}

install -d -o opencode -g opencode -m 0700 "$CACHE_DIR"

echo "github plugin: discovering App installation"
jwt=$(gosu opencode "$GH_APP_SCRIPTS/gh-app-token" --jwt)

slug=$(curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
    https://api.github.com/app | jq -r '.slug // empty')
[ -n "$slug" ] || {
    echo "github plugin: could not read the App's slug — check GH_APP_ID and GH_APP_PRIVATE_KEY_PATH" >&2
    exit 1
}

if [ -n "${GH_APP_INSTALLATION_ID:-}" ]; then
    installation_id="$GH_APP_INSTALLATION_ID"
else
    installations=$(curl -fsS -H "Authorization: Bearer $jwt" -H "Accept: application/vnd.github+json" \
        https://api.github.com/app/installations)
    count=$(printf '%s' "$installations" | jq 'length')
    if [ "$count" -ne 1 ]; then
        echo "github plugin: App '$slug' is installed on $count accounts — set GH_APP_INSTALLATION_ID in .env to pick one" >&2
        exit 1
    fi
    installation_id=$(printf '%s' "$installations" | jq -r '.[0].id')
fi

bot_login="${slug}[bot]"
# --globoff: without it curl treats "[bot]" in the URL as a range pattern.
bot_id=$(curl -fsS --globoff -H "Accept: application/vnd.github+json" \
    "https://api.github.com/users/${bot_login}" | jq -r '.id // empty')
[ -n "$bot_id" ] || {
    echo "github plugin: could not resolve bot user '$bot_login'" >&2
    exit 1
}
bot_email="${bot_id}+${bot_login}@users.noreply.github.com"

printf '{"installation_id": %s, "slug": "%s", "bot_login": "%s", "bot_email": "%s"}' \
    "$installation_id" "$slug" "$bot_login" "$bot_email" > "$CONFIG_FILE.tmp"
chown opencode:opencode "$CONFIG_FILE.tmp"
mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"

echo "github plugin: verifying an installation token can be minted"
gosu opencode "$GH_APP_SCRIPTS/gh-app-token" > /dev/null

echo "github plugin: configuring git identity and credential helper for $bot_login"
gosu opencode git config --global credential."https://github.com".helper "$GH_APP_SCRIPTS/git-credential-github-app"
gosu opencode git config --global user.name "$bot_login"
gosu opencode git config --global user.email "$bot_email"

echo "github plugin: ready ($bot_login, installation $installation_id)"

# Plugin: github — startup hook (runs as root, before privilege drop)
#
# Mints a short-lived App JWT (see gh-app-token --jwt) to discover the App's
# slug and, unless GH_APP_INSTALLATION_ID is set, its installation — this
# only works automatically when the App is installed on exactly one
# account, per README "GitHub plugin". It writes the installation to
# $CACHE_DIR/installation.json for gh-app-token to read, mints an
# installation token, and uses it to resolve the bot user's numeric id
# (needed for the commit-attribution noreply email) — unless
# GH_APP_BOT_USER_ID is set, for orgs that hide the bot account.
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

fail() {
    echo "github plugin: $*" >&2
    exit 1
}

# api_get <step> <bearer credential> <url>
# Prints the response body on 2xx. Otherwise logs "<step>: HTTP <code>
# <GitHub message>" and returns non-zero. Never logs the credential.
# --globoff: bot logins contain "[bot]", which curl would treat as a range.
api_get() {
    step=$1
    body_file=$(mktemp)
    status=$(curl -sS --globoff -o "$body_file" -w '%{http_code}' \
        -H "Authorization: Bearer $2" \
        -H "Accept: application/vnd.github+json" \
        "$3") || status=000
    if [ "${status#2}" = "$status" ]; then
        message=$(jq -r '.message // empty' "$body_file" 2>/dev/null || true)
        rm -f "$body_file"
        echo "github plugin: $step: HTTP $status ${message:-no response body}" >&2
        return 1
    fi
    cat "$body_file"
    rm -f "$body_file"
}

[ -n "${GH_APP_ID:-}" ] || fail "GH_APP_ID is not set"

if [ -n "${GH_APP_BOT_USER_ID:-}" ]; then
    case "$GH_APP_BOT_USER_ID" in
        *[!0-9]*) fail "GH_APP_BOT_USER_ID must be the bot account's numeric user id, not the App ID or Client ID" ;;
    esac
fi

install -d -o opencode -g opencode -m 0700 "$CACHE_DIR"

write_config() {
    printf '%s' "$1" > "$CONFIG_FILE.tmp"
    chown opencode:opencode "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

echo "github plugin: discovering App installation"
jwt=$(gosu opencode "$GH_APP_SCRIPTS/gh-app-token" --jwt)

app=$(api_get "App lookup" "$jwt" https://api.github.com/app) \
    || fail "check GH_APP_ID and GH_APP_PRIVATE_KEY_PATH"
slug=$(printf '%s' "$app" | jq -r '.slug // empty')
[ -n "$slug" ] || fail "App lookup returned no slug"

if [ -n "${GH_APP_INSTALLATION_ID:-}" ]; then
    installation_id="$GH_APP_INSTALLATION_ID"
else
    installations=$(api_get "installation lookup" "$jwt" https://api.github.com/app/installations) \
        || fail "could not list the App's installations"
    count=$(printf '%s' "$installations" | jq 'length')
    if [ "$count" -ne 1 ]; then
        fail "App '$slug' is installed on $count accounts — set GH_APP_INSTALLATION_ID in .env to pick one"
    fi
    installation_id=$(printf '%s' "$installations" | jq -r '.[0].id')
fi

# gh-app-token reads the installation id from here, so write it before minting.
write_config "$(jq -n --argjson id "$installation_id" --arg slug "$slug" \
    '{installation_id: $id, slug: $slug}')"

echo "github plugin: minting an installation token"
token=$(gosu opencode "$GH_APP_SCRIPTS/gh-app-token")

bot_login="${slug}[bot]"
if [ -n "${GH_APP_BOT_USER_ID:-}" ]; then
    bot_id="$GH_APP_BOT_USER_ID"
else
    # Authenticated, because some orgs (e.g. enterprise) hide the bot
    # account from anonymous requests.
    bot=$(api_get "bot lookup" "$token" "https://api.github.com/users/${bot_login}") \
        || fail "the bot account '$bot_login' is not visible (e.g. enterprise org). Set GH_APP_BOT_USER_ID in .env (see README \"GitHub plugin\")"
    bot_id=$(printf '%s' "$bot" | jq -r '.id // empty')
    [ -n "$bot_id" ] || fail "bot lookup returned no id for '$bot_login'"
fi
bot_email="${bot_id}+${bot_login}@users.noreply.github.com"

write_config "$(jq -n --argjson id "$installation_id" --arg slug "$slug" \
    --arg login "$bot_login" --arg email "$bot_email" \
    '{installation_id: $id, slug: $slug, bot_login: $login, bot_email: $email}')"

echo "github plugin: configuring git identity and credential helper for $bot_login"
gosu opencode git config --global credential."https://github.com".helper "$GH_APP_SCRIPTS/git-credential-github-app"
gosu opencode git config --global user.name "$bot_login"
gosu opencode git config --global user.email "$bot_email"

echo "github plugin: ready ($bot_login, installation $installation_id)"

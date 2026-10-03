# Plugin: github
# GitHub CLI (gh), authenticated as a GitHub App rather than a personal
# token. See README "GitHub plugin" for the required .env variables and
# the App setup steps.
#
# jq is required by the scripts below to parse GitHub API responses.
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh jq \
    && rm -rf /var/lib/apt/lists/*

# gh-app-token: mints/caches a 1-hour installation access token (or, with
# --jwt, a 10-minute App-level JWT) from the mounted private key.
COPY --chmod=0755 plugins/github/gh-app-token /usr/local/lib/opencode/github/gh-app-token
# git credential helper: calls gh-app-token so `git clone`/`git push` over
# HTTPS authenticate as the App installation.
COPY --chmod=0755 plugins/github/git-credential-github-app /usr/local/lib/opencode/github/git-credential-github-app
# gh wrapper: shadows /usr/bin/gh on PATH, exporting a fresh GH_TOKEN before
# every invocation (gh itself only reads GH_TOKEN once per process).
COPY --chmod=0755 plugins/github/gh-wrapper /usr/local/bin/gh

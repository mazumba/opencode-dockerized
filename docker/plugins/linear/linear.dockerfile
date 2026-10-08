# Plugin: linear
# jq is used by the startup hook to parse the Linear API response.
RUN apt-get update && apt-get install -y --no-install-recommends \
    jq \
    && rm -rf /var/lib/apt/lists/*

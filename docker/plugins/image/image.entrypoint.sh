#!/bin/sh
# Plugin: image — startup hook (runs as root, before privilege drop)
#
# Updates the ClamAV signature database at container startup (never baked
# into the image) and then proves the final `opencode` user can actually
# load and use that database before the container is considered ready.
#
# Fail-closed: any update error, or a scan-readiness failure, aborts startup
# (the caller runs this under `set -e`). Requires network access to reach
# the ClamAV signature mirrors on every container start.
set -e

# /var/lib/clamav may be a freshly created named volume mount (root:root,
# empty) rather than the directory apt created at build time. Ensure it
# exists with the ownership/mode freshclam expects before running it —
# idempotent and non-recursive, so it never touches already-written
# signature files.
install -d -o clamav -g clamav -m 0755 /var/lib/clamav

echo "image plugin: updating ClamAV virus definitions (freshclam)"
freshclam --stdout

# freshclam (run as the 'clamav' user per its config) writes signature files
# with its normal, readable-by-default permissions. Rather than broadly
# mutating permissions here, we rely on that plus the explicit readiness
# check below: if the non-root 'opencode' user genuinely cannot load the
# database, this scan fails and startup aborts (fail-closed).
echo "image plugin: verifying opencode user can load and use the signature database"
gosu opencode clamscan --no-summary -- /usr/bin/true

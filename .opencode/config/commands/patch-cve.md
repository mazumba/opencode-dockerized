---
description: "Triage and patch one or more CVEs: fix via package overrides, Dockerfile upgrade, or add a trivyignore entry"
subtask: false
---

Triage and remediate each CVE ID passed in `$ARGUMENTS`. Multiple CVEs may be space-separated.

## Invocation

```
/patch-cve CVE-2026-42570
/patch-cve CVE-2026-42570 CVE-2026-48962 CVE-2026-9538
```

## Steps

Process each CVE ID in sequence.

### 1. Check `.trivyignore`

Look for the CVE ID in `.trivyignore` in the project root.

- If present **and** the `exp:` date has **not** passed today → skip this CVE, report it as already suppressed.
- If present **and** the `exp:` date **has** passed → re-triage it from scratch.
- If absent → proceed.

### 2. Fetch CVE details

Always fetch from NVD (`https://nvd.nist.gov/vuln/detail/<CVE-ID>`) for general CVE details.

If a `Dockerfile` exists in the project, inspect the `FROM` line to determine the base distro, then additionally check the appropriate distro security tracker:

- **Debian / Ubuntu** → `https://security-tracker.debian.org/tracker/<CVE-ID>`
- **Alpine** → `https://security.alpinelinux.org/vuln/<CVE-ID>`
- **Red Hat / UBI / CentOS** → `https://access.redhat.com/security/cve/<CVE-ID>`
- **Other distros** → search for the distro's own security advisory database

If no Dockerfile exists, NVD alone is sufficient.

Extract:
- Description and CWE
- Affected package name and installed version range
- Fixed version (if any)
- Attack vector and prerequisites (what conditions are required to exploit it)

### 3. Read `AGENTS.md`

If an `AGENTS.md` exists in the project root, read it before proceeding. Use it to:
- Understand the project stack and package manager
- Understand the quality gate protocol to follow after applying a fix
- Understand any project-specific context relevant to reachability assessment

### 4. Detect ecosystem and fix path

Determine which of the following applies. Use `AGENTS.md` context to disambiguate when multiple match.

#### A — Node/JS package

The affected package appears in one of: `bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`.

Check whether the installed version in the lockfile is within the vulnerable range and whether a fixed version exists.

- **bun / npm:** propose adding or updating `"overrides": { "<package>": "<fixed-version>" }` in `package.json`
- **yarn:** propose `"resolutions": { "<package>": "<fixed-version>" }` in `package.json`
- **pnpm:** propose `"overrides"` in `package.json` (pnpm supports the same field)

Propose the change and **wait for approval** before applying.

After approval:
1. Apply the manifest change
2. Run the appropriate install command inside the container/environment as described in `AGENTS.md` (e.g. `bun install`, `npm install`)
3. Verify the lockfile no longer contains the vulnerable version
4. Follow the quality gate protocol from `AGENTS.md`

#### B — System package installed in a Dockerfile

The affected package is a system package and the project has a `Dockerfile`.

Inspect the `FROM` line to detect the base image and distro. Use that to:
1. Determine the package manager in use (`apt-get`, `apk`, `yum`, `dnf`, `microdnf`, etc.)
2. Check the appropriate distro security tracker (as identified in step 2) for whether a fixed version is available in that specific release

If a fix is available:
- Inspect existing `RUN` blocks in the Dockerfile for the pattern already used for package upgrades (e.g. `--only-upgrade`, `apk add --upgrade`, inline CVE comments, etc.)
- Propose updating or adding an upgrade step following the existing style in the file
- **Wait for approval** before applying

After approval:
1. Apply the Dockerfile change, adding a separate upgrade line for every distinct package named in the CVE — do not assume upgrading one package will transitively upgrade another.
2. Follow the quality gate protocol from `AGENTS.md` if it covers image/build steps

#### C — No fix available, or package not reachable

Use this path when:
- No fixed version exists in any supported release
- The attack vector requires conditions that are not present in this project (e.g. requires extracting attacker-controlled archives, running Perl scripts, listening on a specific interface — none of which this service does)
- The package is a system package not installed in a Dockerfile

Assess reachability honestly: describe what the CVE requires to exploit and why this project does not satisfy those conditions.

Propose a `.trivyignore` entry following this format exactly (match the style of existing entries in the file if one exists):

```
# <Short description of the vulnerability> (<CWE if known>)
# <One sentence: why the attack vector is not reachable in this project, or why no fix is available.>
# No fixed version available in <distro + release> as of <today's date> / Fixed in <upstream version> but unfixed in <distro + release> as of <today's date>.
# Track: <URL to the appropriate distro security tracker or NVD>
<CVE-ID> exp:<YYYY-MM-DD one month from today>
```

**Wait for approval** before writing to `.trivyignore`.

### 5. Report

After processing all CVEs, output a concise summary table:

| CVE | Package | Action taken |
|-----|---------|-------------|
| CVE-XXXX-XXXXX | package-name | Fixed via overrides / Dockerfile updated / Added to trivyignore / Already suppressed (expires YYYY-MM-DD) |

Never silently skip a CVE. If something is unclear or the fix path is ambiguous, ask before proceeding.

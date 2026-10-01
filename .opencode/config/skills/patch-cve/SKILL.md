---
name: patch-cve
description: Triage and remediate CVEs via package overrides, a Dockerfile upgrade, or a justified .trivyignore entry. Use when the user names one or more CVE IDs, pastes a Trivy or other vulnerability scan, or asks to patch or suppress a CVE.
---

# Patch CVE

Triage and remediate each CVE ID the user supplies, in sequence. Every CVE ends in exactly one outcome: fixed, suppressed with justification, or already suppressed. Each fix path proposes a change and waits for approval before writing anything.

## 1. Check `.trivyignore`

Look for the CVE ID in `.trivyignore` in the project root.

- Present and the `exp:` date has not passed today: report it as already suppressed and move on.
- Present and the `exp:` date has passed: re-triage from scratch.
- Absent: proceed.

## 2. Fetch CVE details

Always fetch `https://nvd.nist.gov/vuln/detail/<CVE-ID>`.

If a `Dockerfile` exists, read its `FROM` line to determine the base distro and also check that distro's security tracker:

| Distro | Tracker |
|---|---|
| Debian / Ubuntu | `https://security-tracker.debian.org/tracker/<CVE-ID>` |
| Alpine | `https://security.alpinelinux.org/vuln/<CVE-ID>` |
| Red Hat / UBI / CentOS | `https://access.redhat.com/security/cve/<CVE-ID>` |
| Other | the distro's own security advisory database |

Extract:

- Description and CWE
- Affected package and vulnerable version range
- Fixed version, if any
- Attack vector and the conditions required to exploit it

## 3. Read `AGENTS.md`

If `AGENTS.md` exists in the project root, read it before choosing a fix path. It supplies the stack and package manager, the quality gate to run after a fix, and project context for the reachability assessment.

## 4. Choose the fix path

Pick the single path that applies. When several match, disambiguate with `AGENTS.md`.

### A. Node/JS package

The affected package appears in `bun.lock`, `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml`, and the locked version lies within the vulnerable range.

Propose the manifest change for the package manager in use:

- bun, npm, pnpm: `"overrides": { "<package>": "<fixed-version>" }` in `package.json`
- yarn: `"resolutions": { "<package>": "<fixed-version>" }` in `package.json`

After approval:

1. Apply the manifest change.
2. Run the install command in the environment `AGENTS.md` describes (for example `bun install`, `npm install`).
3. Verify the lockfile no longer contains the vulnerable version.
4. Run the quality gate from `AGENTS.md`.

### B. System package installed in a Dockerfile

The affected package is a system package and the project has a `Dockerfile`.

1. From the `FROM` line, determine the package manager (`apt-get`, `apk`, `yum`, `dnf`, `microdnf`).
2. Confirm on the distro tracker from step 2 that a fixed version exists for that specific release.
3. Match the upgrade pattern already used in the Dockerfile's `RUN` blocks (for example `--only-upgrade`, `apk add --upgrade`, inline CVE comments) and propose an upgrade step in that style.

After approval:

1. Apply the Dockerfile change with a separate upgrade line for every distinct package named in the CVE. Upgrading one package does not transitively upgrade another.
2. Run the quality gate from `AGENTS.md` if it covers image or build steps.

### C. No fix available, or not reachable

Use this path when:

- No fixed version exists in any supported release.
- Exploitation requires conditions this project does not meet (for example extracting attacker-controlled archives, running Perl scripts, listening on a specific interface).
- The package is a system package that no Dockerfile installs.

Assess reachability honestly: state what the CVE requires to exploit and why this project does not satisfy those conditions.

Propose a `.trivyignore` entry in this exact format, matching the style of existing entries if the file exists:

```
# <Short description of the vulnerability> (<CWE if known>)
# <One sentence: why the attack vector is not reachable here, or why no fix is available.>
# No fixed version available in <distro + release> as of <today's date> / Fixed in <upstream version> but unfixed in <distro + release> as of <today's date>.
# Track: <URL of the distro security tracker or NVD>
<CVE-ID> exp:<YYYY-MM-DD one month from today>
```

## 5. Report

After processing all CVEs, output a summary table:

| CVE | Package | Action taken |
|-----|---------|-------------|
| CVE-XXXX-XXXXX | package-name | Fixed via overrides / Dockerfile updated / Added to trivyignore / Already suppressed (expires YYYY-MM-DD) |

Every CVE appears in the table. If a fix path is ambiguous, ask before proceeding.

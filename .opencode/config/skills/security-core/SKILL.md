---
name: security-core
description: "Use when establishing or reviewing a defensive security baseline across projects: threat model, auth/authz, validation, secrets, deps, logging, disclosure."
---

# Skill: security-core

## Overview

Application security core covers baseline risk discovery and control verification across architecture, code, dependencies, runtime configuration, and operational response. It includes threat modeling, identity and access checks, input handling controls, secret management hygiene, and monitoring/disclosure readiness. The domain focuses on reducing exploitability and blast radius while improving detection and recovery quality.

## File & Directory Map

| Path | Purpose |
|---|---|
| `SKILL.md` | This reference file |
| `GOTCHAS.md` | Known failure points and fixes |
| `HISTORY.md` | Append-only change log |
| `assets/` | Shared templates and output scaffolds |
| `assets/finding-template.json` | Canonical finding output schema |
| `assets/threat-model-template.md` | Lightweight threat model snapshot template |
| `assets/disclosure-intake-template.md` | Coordinated disclosure intake template |
| `assets/remediation-tracker-template.csv` | Remediation tracking starter sheet |
| `scripts/` | Helper scripts and libraries the agent can run or compose (if any) |

## Key Facts

- This skill is defensive-only. It is for risk discovery, validation, mitigation planning, and response readiness; it is not for exploit development, payload design, or offensive operation support.
- Scope is baseline controls reusable across repositories; project-specific enforcement and stack details belong in a companion `security-profile` skill per repository.
- Security review scope commonly spans design-time, build-time, deploy-time, and runtime controls; missing any layer creates false confidence.
- Severity language should be stable across findings: `critical`, `high`, `medium`, `low`, `informational`; include both `impact` and `likelihood` rationale.
- Prefer explicit trust boundaries and data-flow labels for threat models: `external`, `partner`, `internal`, `privileged`, `regulated`.

| Severity | Impact Guide | Likelihood Guide | Typical SLA Target |
|---|---|---|---|
| `critical` | Immediate compromise of sensitive systems/data | Active abuse or trivial path | Same day |
| `high` | Significant data, auth, or integrity impact | Realistic exploit path | 7 days |
| `medium` | Scoped impact or strong preconditions | Possible with constraints | 30 days |
| `low` | Limited impact, defense-in-depth gap | Unlikely or narrow | 90 days |
| `informational` | No direct exploit impact | N/A | Backlog |

| Control Area | Minimum Expectation | Frequent Failure Mode |
|---|---|---|
| Threat modeling | Assets, actors, trust boundaries, abuse cases are explicit | Focus on features, skip attacker paths |
| Dependency/supply-chain | Lockfiles, provenance checks, vulnerability triage SLA | Unpinned transitive updates, ignored advisories |
| Auth/Authz | Strong authN, server-side authZ, deny-by-default policy | Client-side-only checks, role drift |
| Input validation | Centralized allowlist validation and output encoding | Validation only at edge, inconsistent schemas |
| Secrets/config | No hardcoded secrets, env isolation, rotation metadata | Secrets in logs/repos, shared credentials |
| Logging/alerting | Structured security events with actionable alert routing | Missing actor/context, noisy unactionable alerts |
| Disclosure readiness | Public reporting channel and coordinated response template | No owner, ad hoc communication |

| Risk Dimension | Canonical Values |
|---|---|
| Data class | `public`, `internal`, `confidential`, `restricted` |
| Auth mechanism | `password`, `oauth2`, `oidc`, `mTLS`, `api-key` |
| Access model | `RBAC`, `ABAC`, `ReBAC`, `ACL` |
| Secret location | `env`, `secret-manager`, `kms`, `vault`, `file` |
| Log outcome | `allowed`, `denied`, `error`, `anomaly` |

```json
{
  "finding_id": "SEC-2026-0001",
  "project": "payments-platform",
  "environment": "production",
  "area": "authz",
  "severity": "high",
  "asset": "billing-api",
  "summary": "IDOR on invoice read endpoint",
  "evidence": "GET /invoices/{id} returns cross-tenant data",
  "impact": "Confidential billing data exposure",
  "likelihood": "Medium; endpoint enumerable",
  "recommended_control": "Server-side ownership check on invoice tenant_id",
  "owner": "payments-team",
  "status": "open"
}
```

```text
Defensive non-goals:
- No exploit chains, shellcode, payload crafting, or attack automation details
- No instructions intended to bypass controls in production systems
- If offensive detail is requested, redirect to mitigation, detection, and patch validation guidance
```

```text
Disclosure template fields:
- report_id
- received_at_utc
- reporter_contact
- affected_products
- affected_versions
- impact_statement
- reproduction_steps
- temporary_mitigation
- fix_version_or_eta
- public_advisory_url
```

## Cross-References

- Related skill: `security-profile` — per-repo overlays for stack-specific checks, thresholds, and CI commands.
- Related skill: `release-engineering` — coordinates dependency patching and security gates in CI/CD.

# Gotchas

Every real mistake, wrong assumption, and edge case discovered while working in this domain.
Add an entry whenever something breaks unexpectedly. Also log it in HISTORY.md.

---

<!-- Add entries below as they are discovered. Format:

### <Short title>

**Symptom:** What you observe / what breaks
**Root cause:** Why it happens
**Fix:** What to do instead

-->

### Boundary assumptions hidden in internal calls

**Symptom:** Reviews mark service-to-service paths as trusted and miss authz gaps.
**Root cause:** Trust boundary map includes only public ingress and ignores lateral/internal entry points.
**Fix:** Model every caller path explicitly, including internal jobs, queues, and service tokens.

### Security findings without actionable ownership

**Symptom:** Findings are logged but remain open across multiple release cycles.
**Root cause:** Reports omit single-team ownership, due date, and SLA tier.
**Fix:** Require owner, target date, and severity-based SLA in every finding record.

### Alert volume masks real incidents

**Symptom:** Security alerts are ignored and true positives are discovered late.
**Root cause:** Event schema misses actor/context fields, producing noisy low-fidelity alerts.
**Fix:** Enforce structured event fields for actor, target, outcome, and reason before routing alerts.

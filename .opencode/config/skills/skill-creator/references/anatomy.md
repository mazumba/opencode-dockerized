# Skill anatomy

Section order and formats for a generated `SKILL.md`. Drop any section the skill does not need; a short reference skill may be just frontmatter plus one section.

1. **Frontmatter.** opencode reads only `name`, `description`, `license`, `compatibility` and `metadata`. Description rules live in `writing-for-agents`: front-load the leading word, one trigger per distinct branch, explicit exclusions. Include the casual phrasing a user types when it is a distinct trigger ("is this good?" for a review skill), not as a synonym list.
2. **Vocabulary payload** (optional; for expert domains). 15-30 terms in 3-5 clusters of 3-8, before any steps, to prime the domain. Attribute named frameworks: "circuit breaker (Nygard)". Practitioner test: would a senior expert with 15 years in the domain use this exact term with a peer? Drop every term that fails.
3. **Anti-pattern watchlist** (optional; for skills that judge or produce work). 5-10 established names, each with **Detection** (observable signal) and **Resolution** (the positive target behaviour). Place before the steps so the agent checks for them first.
4. **Steps and/or reference.** Steps: numbered, imperative, IF/THEN for branches, each ending on a completion criterion, with the WHY only where a step is non-obvious. Reference: tables, code blocks, bullets.
5. **Output contract** (when the skill produces an artefact). Required fields and structure as a template, YAML or table.
6. **Examples.** 2-3 diverse BAD/GOOD or input-to-output pairs, one hard case, the most representative one last. Move longer sets into `references/`.

## Examples

### Description

BAD: `description: "Helps with code review."`: one vague trigger, no domain term, no exclusion.

GOOD:
```yaml
description: Reviews diffs for coupling and change risk (connascence, shotgun surgery). Use when the user asks to review code or a PR, or asks "is this good?" about a change. Not for architecture decisions or writing new code.
```

### Vocabulary payload

BAD: `good code, clean code, readable, maintainable, well-tested`: blog-post words no expert uses as a precise concept.

GOOD:
```
**Structural analysis:** cyclomatic complexity (McCabe), cognitive complexity (SonarSource), afferent/efferent coupling (Martin), connascence (Page-Jones)
**Change safety:** shotgun surgery (Fowler), feature envy, divergent change, Liskov substitution violation
**Review process:** conventional comments (Slaughter), diff review vs design review
```

### Hard case: vague request

BAD: "Create a skill for APIs" → drafts a generic API skill.

GOOD: ask first whether it targets REST contract design, GraphQL schema evolution, SDK generation or API incident response, then build triggers, vocabulary, watchlist and output contract for that target.

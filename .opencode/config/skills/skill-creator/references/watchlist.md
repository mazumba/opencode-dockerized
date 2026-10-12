# Draft watchlist

Check every draft against each entry. Each one names a failure in generated skills, how to spot it, and the fix.

### 1. Consultant-speak
**Detection:** "best practices", "leverage", "robust", "scalable framework", "holistic"; any term that fails the practitioner test.
**Resolution:** Replace it with the precise term it gestures at: "error-handling best practices" → "circuit breaker (Nygard), exponential backoff, dead letter queue".

### 2. Over-prompting
**Detection:** `SKILL.md` over 200 lines; one idea restated for emphasis; hedges ("you might want to consider"); instructions the model already follows by default.
**Resolution:** State each instruction once, imperatively. Delete no-op sentences whole. Disclose heavy material into `references/`.

### 3. Missing guardrails
**Detection:** A skill that judges or produces work with no named failure modes.
**Resolution:** Add a watchlist of named patterns whose resolutions state the target behaviour positively.

### 4. Weak trigger surface
**Detection:** The description would not fire on the casual phrasing users actually type, or it lists synonyms of one branch instead of distinct branches, or it has no exclusions.
**Resolution:** One trigger per distinct branch, using the user's own words where they differ from the formal term; add "Not for ..." exclusions.

### 5. Edge-case stuffing
**Detection:** More than 15 "if X then Y" rules covering individual cases.
**Resolution:** Replace them with 2-3 canonical examples, including a hard case, and let the model generalise.

### 6. Paragraph logic
**Detection:** A multi-step workflow written as prose, with no numbered steps, conditions or completion criteria.
**Resolution:** Turn it into numbered imperative steps with IF/THEN branches, each ending on a checkable completion criterion.

### 7. Missing examples
**Detection:** No BAD/GOOD or input-to-output pair anywhere in the skill folder.
**Resolution:** Add 2-3 diverse pairs, with the most representative one last.

### 8. Undisclosed bulk
**Detection:** Material only some branches need sits inline, or a disclosed file has no pointer stating when to read it.
**Resolution:** Move it behind a pointer that names its read condition; keep reference files under 300 lines.

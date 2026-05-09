---
name: review-council
description: Run code review tools in parallel, validate findings with a second-opinion agent, and aggregate a comprehensive review report.
disable-model-invocation: true
---

## Context

- Current branch: !`git branch --show-current`
- Base branch: !`git rev-parse --verify main >/dev/null 2>&1 && echo main || echo master`
- Arguments: $ARGUMENTS

## Task

Act as a **Code Review Orchestrator**: run every reviewer in parallel, re-check their findings with one second-opinion agent, and produce one report.

## Workflow

1. Resolve the review target:
   - PR number in `$ARGUMENTS`: pass it to every reviewer.
   - File path or set of changes in `$ARGUMENTS`: pass it directly.
   - Empty `$ARGUMENTS`: review the current branch against the base branch.
2. Discover reviewers: inspect available skills and select every skill whose name or description indicates code review, PR review, or security review. Exclude this skill itself (`review-council`) to avoid recursion.
3. Launch reviewers: in a single message, start one read-only sub-agent per reviewer. Each sub-agent must invoke its skill via the Skill tool with the resolved target, return its full review output, and never modify files, create commits, or push.
4. Aggregate: wait for all reviewers, extract issues only, redact secrets, deduplicate matching issues, and omit raw reviewer output.
5. Second opinion: after aggregation, launch one more read-only sub-agent to re-check every deduplicated issue against the target. Keep every original issue and severity; add that agent's concise comment: confirmed, invalid, low-value, or needs clarification, with a short reason.

## Report

Return exactly:

```
# Full Code Review Report

## Summary
[1-2 sentence overall assessment with the reviewer count and issue count. When some reviewers fail, add a clause such as `2 reviewers failed (skill-a, skill-b)` — count outside, names inside the parens. Skip this clause when everything succeeded.]

## Issues

| Severity | Issue | File:Line | Reviewers | Second Opinion |
|----------|-------|-----------|-----------|----------------|
| Critical | ... | path/to/file.ts:42 | reviewer-a, reviewer-b | Confirmed: ... |
| Important | ... | path/to/file.ts:108 | reviewer-c | Invalid: ... |
| Minor | ... | path/to/file.ts:15 | reviewer-a | Low-value: ... |
```

## Rules

- Do NOT skip any discovered reviewer. If a reviewer fails, do NOT add it to the issues table and do NOT create a separate section for it — just note it inline in the Summary parenthetical.
- Run the second-opinion agent even if only one reviewer succeeds; if it fails, write `Unavailable: second-opinion agent failed` in every Second Opinion cell.
- If multiple reviewers flag the same issue (same file, same line, same concern), merge them into one row and list all reviewers that caught it in the Reviewers column.
- If reviewers disagree on severity, use the highest. Severity ranking: Critical > Important > Minor.
- If 3+ reviewers flag the same issue, prefix the Issue cell with `[CONSENSUS]`.
- Sort the table by severity (Critical first, then Important, then Minor).
- Keep each Issue cell to one short sentence. No code blocks, no multi-line entries.
- Keep each Second Opinion cell to one short sentence. No code blocks, no multi-line entries.
- Redact any credentials, secrets, API keys, tokens, or passwords that may appear in extracted issues.

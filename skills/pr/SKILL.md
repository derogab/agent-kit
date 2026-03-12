---
name: pr
description: Create or update a pull request for the current branch with a summary of all changes.
disable-model-invocation: true
---

## Context

- Current branch: !`git branch --show-current`
- Default branch candidates: !`git branch -r | grep -E 'origin/(main|master)'`
- PR for this branch: !`gh pr view --json number,title,url 2>/dev/null || echo "NO_PR"`

## Your task

Create or update a pull request for the current branch.

### Pre-flight checks

1. Detect the base branch by running: `git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master`. Use this as `<base>`.
2. If the current branch is the base branch, stop and tell the user to switch to a feature branch first. Do nothing else.
3. Run `git log <base>..HEAD --oneline`. If there are **no commits** ahead of the base branch, stop and tell the user to commit changes first. Do nothing else.
4. Never run `git add` or `git commit`. Only manage the PR.

### Analysis

1. Run `git diff <base>...HEAD` to get the full diff of all changes on this branch.
2. Run `git log <base>..HEAD --format="%h %s"` to get all commit messages.
3. Identify the **main topic**, group **specific changes** logically.

### Decide: create or update

- If the PR context above shows `NO_PR` → **create** a new PR.
- If a PR is found for the current branch → **update** that PR.

### PR title

Follow **Conventional Commits** format: `<type>: <description>`.

**Types:** feat, fix, docs, refactor, test, chore, build, perf, ci. Append `!` for breaking changes.

When **updating**, keep the existing title unless it is generic (e.g. "Update"), outdated, or does not follow Conventional Commits.

### PR body format

```
## Summary
<1-2 sentence high-level description of what this PR does and why>

## Changes
<bulleted list of all meaningful changes, grouped logically>

## Test plan
<bulleted checklist of how to verify these changes>
```

### Execution

**Create flow:**
1. Push the branch to origin: `git push -u origin <branch>`.
2. Create the PR: `gh pr create --title "<title>" --body "<body>"`.

**Update flow:**
1. Update the PR: `gh pr edit --title "<title>" --body "<body>"`.

### Rules

- Write the summary in plain English, focusing on the **why** and the **what**.
- List changes as concise bullet points. Group related items under sub-headers if the PR touches multiple areas.
- The test plan should contain actionable verification steps relevant to the changes. If a check was already run and passed, mark it as done.
- Use a HEREDOC to pass the body to `gh pr create` or `gh pr edit`.
- Do not send any text besides the tool calls.

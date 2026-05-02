---
name: pr
description: Create or update a pull request for the current branch with a summary of all changes. Use when the user asks to open, create, update, or refresh a PR/pull request.
disable-model-invocation: false
user-invocable: true
allowed-tools: Bash(git branch:*) Bash(git rev-parse:*) Bash(git log:*) Bash(git diff:*) Bash(gh pr view:*) Bash(gh pr create:*) Bash(gh pr edit:*) Read
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

First, check if the repository has a PR template. Look for these files in order:
1. `pull_request_template.md` in the repo root
2. `.github/pull_request_template.md`
3. `.github/PULL_REQUEST_TEMPLATE/*.md`

**If multiple templates exist in `.github/PULL_REQUEST_TEMPLATE/`:**
- Read all template files in that directory
- Analyze the current changes (types of files modified, nature of changes)
- Select the template whose filename and content best match the changes (e.g., `bugfix.md` for bug fixes, `feature.md` for new features, `docs.md` for documentation changes)

**If a template is found:**
- Use the template's content as the PR body
- Replace any placeholder variables (e.g., `{{description}}`, `{{summary}}`) with actual content derived from the changes
- If the template includes a checklist, only check items that are truly complete and verified. Leave items unchecked when the related work is not done, not validated yet, or failed.
- If you can reasonably perform a check needed to validate a checklist item (for example by reading the diff, inspecting files, or running an available verification command), do it before deciding whether the item should be checked.

**If no template is found, use this default format:**
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
2. Create the PR:
   ```bash
   gh pr create --title "<title>" --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```

**Update flow:**
1. Update the PR:
   ```bash
   gh pr edit --title "<title>" --body "$(cat <<'EOF'
   <body>
   EOF
   )"
   ```

### Rules

- Write the summary in plain English, focusing on the **why** and the **what**.
- List changes as concise bullet points. Group related items under sub-headers if the PR touches multiple areas.
- The test plan should contain actionable verification steps relevant to the changes. If a check was already run and passed, mark it as done.
- If the PR body includes a checklist from a template, never auto-check every item. Each checked item must match work that is actually done and confirmed.
- When a checklist item can be validated with available evidence or commands, verify it instead of guessing.
- Do not send any text besides the tool calls.

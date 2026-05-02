---
name: reply
description: Reply to unresolved PR review comments that relate to the current conversation context.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git branch:*) Bash(gh pr view:*)
---

## Context

- Current branch: !`git branch --show-current`
- PR for this branch: !`gh pr view --json number,url 2>/dev/null || echo "NO_PR"`

## Your task

Reply to **unresolved** review comments on the current PR that relate to what we have been discussing in this conversation. Skip every other comment.

### Pre-flight checks

1. If the PR context above is `NO_PR`, stop and tell the user there is no PR for this branch. Do nothing else.
2. Never reply to comments that are already resolved.
3. Never reply to comments that are unrelated to the current conversation context.
4. Never resolve threads. Never modify any files. This skill only posts replies.

### Resolve the repository coordinates

Get owner, repo, and PR number for the API calls below:

```bash
OWNER=$(gh repo view --json owner -q .owner.login)
REPO=$(gh repo view --json name -q .name)
PR=$(gh pr view --json number -q .number)
```

### Fetch unresolved review threads

Use the GraphQL API to list every review thread on the PR with its resolution status and the comments inside:

```bash
gh api graphql -F owner="$OWNER" -F repo="$REPO" -F pr="$PR" -f query='
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              databaseId
              author { login }
              body
              path
              line
              url
            }
          }
        }
      }
    }
  }
}'
```

Filter the result to threads where `isResolved` is `false`. For each unresolved thread, the first comment's `databaseId` is the one you reply to.

### Match against conversation context

For each unresolved thread:

1. Read every comment in the thread.
2. Decide whether the topic relates to **this conversation** — files we have edited, decisions we have discussed, errors we have debugged, code we have written together.
3. If the thread is unrelated, skip it. Do not reply.
4. If the thread is related, draft a reply grounded in what the conversation actually established. Examples:
   - "Done in `<commit-sha>`."
   - "Changed to `<approach>` because `<reason discussed>`."
   - "Good catch — kept the previous behavior because `<reason>`."
5. When in doubt about relevance, skip. False positives are worse than missed replies.

### Post the reply

For each matching thread, post a threaded reply to the **first comment** of that thread:

```bash
gh api repos/$OWNER/$REPO/pulls/$PR/comments/<first_comment_databaseId>/replies \
  -X POST \
  -f body="$(cat <<'EOF'
<your reply here>
EOF
)"
```

### Rules

- Only consider threads where `isResolved` is `false`.
- Only reply when the thread clearly relates to something in the current conversation.
- Keep replies concise and factual. Do not invent context.
- Do not reply twice to the same thread in one run.
- Do not resolve threads. Do not edit code. Do not push commits. Only post replies.
- After posting, briefly summarize to the user which threads were replied to and which were skipped (with a one-line reason for each skip).

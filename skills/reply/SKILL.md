---
name: reply
description: Reply to unresolved PR review comments that clearly relate to the current conversation. Use when the user asks to respond to PR review feedback without resolving threads or editing code.
disable-model-invocation: true
user-invocable: true
allowed-tools: Bash(git branch:*) Bash(gh pr view:*) Bash(gh repo view:*) Bash(gh api:*)
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
CURRENT_USER=$(gh api user -q .login)
```

### Fetch unresolved review threads

Use the GraphQL API to list every review thread page on the PR with its resolution status and the comments inside. Run the first request with `-F threadsCursor=null`:

```bash
gh api graphql \
  -F owner="$OWNER" \
  -F repo="$REPO" \
  -F pr="$PR" \
  -F threadsCursor=null \
  -f query='
query($owner: String!, $repo: String!, $pr: Int!, $threadsCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $threadsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              databaseId
              author { login }
              body
              path
              line
              url
              createdAt
            }
          }
        }
      }
    }
  }
}'
```

If `reviewThreads.pageInfo.hasNextPage` is `true`, rerun the same query with `-F threadsCursor="<endCursor>"` until `hasNextPage` is `false`. Combine all returned thread nodes before filtering.

If any unresolved thread has `comments.pageInfo.hasNextPage` set to `true`, fetch the remaining comments before deciding whether to reply:

```bash
gh api graphql \
  -F thread="$THREAD_ID" \
  -F commentsCursor="<endCursor>" \
  -f query='
query($thread: ID!, $commentsCursor: String) {
  node(id: $thread) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $commentsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          databaseId
          author { login }
          body
          path
          line
          url
          createdAt
        }
      }
    }
  }
}'
```

Repeat comment pagination until `hasNextPage` is `false`.

Filter the combined result to threads where `isResolved` is `false`. For each unresolved thread, the first comment's `databaseId` is the one you reply to.

### Match against conversation context

For each unresolved thread:

1. Read every comment in the thread.
2. If the last comment in the thread is authored by `CURRENT_USER`, skip the thread. A reply is only needed when someone else has added the latest comment.
3. Decide whether the topic relates to **this conversation** — files we have edited, decisions we have discussed, errors we have debugged, code we have written together.
4. If the thread is unrelated, skip it. Do not reply.
5. If the thread is related, draft a reply grounded in what the conversation actually established. Examples:
   - "Done in `<commit-sha>`."
   - "Changed to `<approach>` because `<reason discussed>`."
   - "Good catch — kept the previous behavior because `<reason>`."
6. When in doubt about relevance, skip. False positives are worse than missed replies.

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
- Skip threads where the last comment is authored by `CURRENT_USER`.
- Keep replies concise and factual. Do not invent context.
- Do not reply twice to the same thread in one run.
- Do not resolve threads. Do not edit code. Do not push commits. Only post replies.
- After posting, briefly summarize to the user which threads were replied to and which were skipped (with a one-line reason for each skip).

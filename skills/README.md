# Skills

Follows the [Agent Skills](https://agentskills.io) open standard.

| Skill | Description |
|-------|-------------|
| [`/commit`](./commit/) | Create a conventional commit from staged changes |
| [`/pr`](./pr/) | Create or update a pull request for the current branch |
| [`/review-council`](./review-council/) | Orchestrate a full code review across all available reviewers |
| [`/worktree`](./worktree/) | Resolve missing gitignored files in a git worktree via symlinks |

## Install

```bash
npx skills add -g derogab/agent-kit
```

or symlink the skills you need into your agent's skills folder:

```bash
ln -s /path/to/agent-kit/skills/commit ~/path/to/your/agent/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/path/to/your/agent/skills/pr
ln -s /path/to/agent-kit/skills/review-council ~/path/to/your/agent/skills/review-council
ln -s /path/to/agent-kit/skills/worktree ~/path/to/your/agent/skills/worktree
```

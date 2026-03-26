# Skills

Follows the [Agent Skills](https://agentskills.io) open standard.

| Skill | Description |
|-------|-------------|
| [`/commit`](./commit/) | Create a conventional commit from staged changes |
| [`/pr`](./pr/) | Create or update a pull request for the current branch |
| [`/redis`](./redis/) | Read the Redis Patterns for Coding Agents documentation before answering Redis questions or making Redis changes |
| [`/review-council`](./review-council/) | Orchestrate a full code review across all available reviewers |

## Install

```bash
npx skills add -g derogab/agent-kit
```

or symlink the skills you need into your agent's skills folder:

```bash
ln -s /path/to/agent-kit/skills/commit ~/path/to/your/agent/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/path/to/your/agent/skills/pr
ln -s /path/to/agent-kit/skills/redis ~/path/to/your/agent/skills/redis
ln -s /path/to/agent-kit/skills/review-council ~/path/to/your/agent/skills/review-council
```

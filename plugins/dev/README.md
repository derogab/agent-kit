# dev

A plugin that provides skills to help with everyday development tasks.

## Skills

| Skill | Description |
|-------|-------------|
| `/redis` | Read the Redis Patterns for Coding Agents documentation before answering Redis questions or making Redis changes |
| `/review-council` | Orchestrate a full code review across all available reviewers |

See the [skills documentation](../../skills/) for more details.

## Install

### Universal

```bash
npx skills add -g -y derogab/agent-kit@redis
npx skills add -g -y derogab/agent-kit@review-council
```

### Claude Code

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install dev@agent-kit
```

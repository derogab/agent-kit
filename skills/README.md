# Skills

Follows the [Agent Skills](https://agentskills.io) open standard.

| Skill | Description |
|-------|-------------|
| [`/commit`](./commit/) | Create a conventional commit from staged changes |
| [`/pr`](./pr/) | Create or update a pull request for the current branch |

## Install

Symlink the skills you need into your agent's skills folder:

### Claude Code

```bash
ln -s /path/to/agent-kit/skills/commit ~/.claude/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.claude/skills/pr
```

### OpenCode

```bash
ln -s /path/to/agent-kit/skills/commit ~/.config/opencode/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.config/opencode/skills/pr
```

# Skills

Follows the [Agent Skills](https://agentskills.io) open standard.

| Skill | Description |
|-------|-------------|
| [`/commit`](./commit/) | Create a conventional commit from staged changes |
| [`/pr`](./pr/) | Create or update a pull request for the current branch |

## Install

Symlink the skills you need into your agent's skills folder:

### OpenCode

```bash
ln -s /path/to/agent-kit/skills/commit ~/.config/opencode/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.config/opencode/skills/pr
```

### Claude Code

```bash
ln -s /path/to/agent-kit/skills/commit ~/.claude/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.claude/skills/pr
```

### Codex CLI

```bash
ln -s /path/to/agent-kit/skills/commit ~/.codex/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.codex/skills/pr
```

### Cursor

```bash
ln -s /path/to/agent-kit/skills/commit ~/.cursor/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.cursor/skills/pr
```

### Gemini CLI

```bash
ln -s /path/to/agent-kit/skills/commit ~/.gemini/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.gemini/skills/pr
```

### Antigravity

```bash
ln -s /path/to/agent-kit/skills/commit ~/.gemini/antigravity/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.gemini/antigravity/skills/pr
```

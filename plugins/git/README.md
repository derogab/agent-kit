# git

A Claude Code plugin that provides Git workflow skills for creating commits and managing pull requests following the Conventional Commits specification.

## Skills

| Skill | Description |
|-------|-------------|
| `/commit` | Create a conventional commit from staged changes |
| `/pr` | Create or update a pull request for the current branch |

See the [skills documentation](../../skills/) for more details.

## Install

### OpenCode

```bash
ln -s /path/to/agent-kit/skills/commit ~/.config/opencode/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.config/opencode/skills/pr
```

### Claude Code

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install git@agent-kit
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

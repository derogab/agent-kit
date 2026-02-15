# git

A Claude Code plugin that provides Git workflow skills for creating commits and managing pull requests following the Conventional Commits specification.

## Skills

| Skill | Description |
|-------|-------------|
| `/commit` | Create a conventional commit from staged changes |
| `/pr` | Create or update a pull request for the current branch |

See the [skills documentation](../../skills/) for more details.

## Install

### Claude Code

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install git@agent-kit
```

### OpenCode

```bash
ln -s /path/to/agent-kit/skills/commit ~/.config/opencode/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.config/opencode/skills/pr
```

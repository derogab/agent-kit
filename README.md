# agent-kit

A collection of plugins, skills, agents, and hooks for code agents (e.g. Claude Code, OpenCode, ...).

## What's included

### Skills
Follows the [Agent Skills](https://agentskills.io) open standard.

| Skill | Description |
|-------|-------------|
| `/commit` | Create a conventional commit from staged changes |
| `/pr` | Create or update a pull request for the current branch |

## Install

### Claude Code

Add the marketplace and install the plugin:

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install git@agent-kit
```

### OpenCode

Symlink the skills into your personal skills folder:

```bash
ln -s /path/to/agent-kit/skills/commit ~/.config/opencode/skills/commit
ln -s /path/to/agent-kit/skills/pr ~/.config/opencode/skills/pr
```

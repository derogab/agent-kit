# git

A plugin that provides Git workflow skills for creating commits and managing pull requests following the Conventional Commits specification.

## Skills

| Skill | Description |
|-------|-------------|
| `/commit` | Create a conventional commit from staged changes |
| `/pr` | Create or update a pull request for the current branch |

See the [skills documentation](../../skills/) for more details.

## Install

### Universal

```bash
npx skills add -g -y derogab/agent-kit@commit
npx skills add -g -y derogab/agent-kit@pr
```

### Claude Code

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install git@agent-kit
```

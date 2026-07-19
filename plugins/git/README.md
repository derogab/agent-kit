# git

A plugin that provides skills to help with everyday Git tasks.

## Skills

| Skill | Description |
|-------|-------------|
| `/commit` | Create a conventional commit from staged changes |
| `/pr` | Create or update a pull request for the current branch |
| `/reply` | Reply to unresolved PR review comments clearly related to the current conversation |

See the [skills documentation](../../skills/) for more details.

## Install

### Universal

```bash
npx skills add -g -y derogab/agent-kit@commit
npx skills add -g -y derogab/agent-kit@pr
npx skills add -g -y derogab/agent-kit@reply
```

### Pi

```bash
pi install npm:@derogab/pi-git
```

### Claude Code

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install git@agent-kit
```

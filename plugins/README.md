# Plugins

| Plugin | Agent | Description |
|--------|-------|-------------|
| [dev](./dev/) | Pi, Claude Code | Skills to help with everyday development tasks |
| [exit](./exit/) | Pi | Adds `/exit` as an alias for `/quit` |
| [git](./git/) | Pi, Claude Code | Git workflow skills for commits and pull requests |
| [inkypal](./inkypal/) | Claude Code | Notifies InkyPal when a task finish |
| [sounds](./sounds/) | Claude Code | OS-native sound alerts on events like task completion |

## Install

See each plugin's README for specific install instructions.

### Pi

Install the Pi plugin you need:

```bash
pi install npm:@derogab/pi-dev
pi install npm:@derogab/pi-exit
pi install npm:@derogab/pi-git
```

### Claude Code

Add the marketplace first, then install the plugins you need:

```bash
claude plugin marketplace add derogab/agent-kit
```

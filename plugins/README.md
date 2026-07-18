# Plugins

| Plugin | Agent | Description |
|--------|-------|-------------|
| [dev](./dev/) | Claude Code | Skills to help with everyday development tasks |
| [exit](./exit/) | Pi | Adds `/exit` as an alias for `/quit` |
| [git](./git/) | Claude Code | Git workflow skills for commits and pull requests |
| [inkypal](./inkypal/) | Claude Code | Notifies InkyPal when a task finish |
| [sounds](./sounds/) | Claude Code | OS-native sound alerts on events like task completion |

## Install

See each plugin's README for specific install instructions.

### Pi

Clone this repository, then install the plugin you need:

```bash
git clone https://github.com/derogab/agent-kit.git
pi install ./agent-kit/plugins/exit
```

### Claude Code

Add the marketplace first, then install the plugins you need:

```bash
claude plugin marketplace add derogab/agent-kit
```

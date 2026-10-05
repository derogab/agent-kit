# Plugins

| Plugin | Agent | Description |
|--------|-------|-------------|
| [auto-mode](./auto-mode/) | Pi | Checks Bash commands before execution |
| [clear](./clear/) | Pi | Adds `/clear` as an alias for `/new` |
| [coffee](./coffee/) | Pi | Keeps your Mac and display awake while Pi is running |
| [dev](./dev/) | Pi, Claude Code | Skills to help with everyday development tasks |
| [exit](./exit/) | Pi | Adds `/exit` as an alias for `/quit` |
| [git](./git/) | Pi, Claude Code | Git workflow skills for commits and pull requests |
| [goal](./goal/) | Pi | Keeps working until a goal is reached |
| [inkypal](./inkypal/) | Claude Code | Notifies InkyPal when a task finish |
| [later](./later/) | Pi | Save prompts and run them later in the session |
| [schedule](./schedule/) | Pi | Schedule future and recurring tasks |
| [sounds](./sounds/) | Claude Code | OS-native sound alerts on events like task completion |

## Install

See each plugin's README for specific install instructions.

### Pi

Install the Pi plugin you need:

```bash
pi install npm:@derogab/pi-auto-mode
pi install npm:@derogab/pi-clear
pi install npm:@derogab/pi-coffee
pi install npm:@derogab/pi-dev
pi install npm:@derogab/pi-exit
pi install npm:@derogab/pi-git
pi install npm:@derogab/pi-goal
pi install npm:@derogab/pi-later
pi install npm:@derogab/pi-schedule
```

### Claude Code

Add the marketplace first, then install the plugins you need:

```bash
claude plugin marketplace add derogab/agent-kit
```

# coffee

A Pi plugin that keeps your Mac and display awake while Pi is running, using macOS's built-in `caffeinate`.

## Install

### Pi

Install the plugin from npm:

```bash
pi install npm:@derogab/pi-coffee
```

Restart Pi or run `/reload` to activate it in an existing session.

## Usage

- Starts automatically when a Pi session opens, preventing display sleep and idle system sleep even while Pi is waiting for input.
- Stops automatically when Pi closes, crashes, or is killed, including force-kill.
- Supports multiple Pi instances: closing one does not remove the others' keep-awake protection. Normal sleep behavior resumes after the last instance closes, unless another app is keeping the Mac awake.
- Continues working across `/reload`, `/new`, and session changes.

No commands or configuration are required. To disable it, use `pi config`, then restart Pi or run `/reload`.

## Requirements and limitations

- Requires macOS with `/usr/bin/caffeinate`. Does nothing on other operating systems.
- Applies to the Mac running Pi, not a separate computer connected to it remotely.
- Does not override lid-close sleep, explicit Sleep, or macOS locking policies.
- Keeping the display and system awake increases power usage, including on battery.
- If keep-awake protection fails, Pi reports a warning. Run `/reload` to retry.

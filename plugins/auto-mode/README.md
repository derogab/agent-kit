# auto-mode

A Pi plugin that automatically checks model-issued Bash commands before execution.

> **WARNING**: this plugin is under active development and must be considered alpha software. Use it with caution.

## How it works

1. A matching deny pattern blocks the command.
2. A matching ask pattern requests user confirmation.
3. A command covered by allow patterns runs automatically.
4. Anything else goes to a separate AI safety check.

Deny rules take precedence over ask and allow rules, and ask rules take precedence over allow rules. The AI check also returns `ALLOW`, `ASK`, or `DENY`. If auto-mode cannot check a command safely, it blocks it.

Auto-mode only checks the command while making this decision. It does not execute it, rewrite it, or change files. Pi can run the command only after an `ALLOW` or a confirmed `ASK`.

## Install

```bash
pi install npm:@derogab/pi-auto-mode
```

## Configure

Create `auto-mode.json` in either or both locations:

- Pi's user agent directory, normally `~/.pi/agent/auto-mode.json`
- The trusted project's `.pi/auto-mode.json`

```json
{
  "allow": [
    "^git status$",
    "^git diff$",
    "^npm (test|run (lint|build))(?:\\s|$)"
  ],
  "ask": [
    "^git push(?:\\s|$)"
  ],
  "deny": [
    "^git push --force$",
    "(^|\\s)(sudo|doas)(\\s|$)",
    "\\brm\\b\\s+-(?=[a-zA-Z]*r)(?=[a-zA-Z]*f)[a-zA-Z]+"
  ]
}
```

Rules from both files are combined. Each entry is a case-sensitive JavaScript regular expression. If both files are missing, commands use the AI phase; if either file is invalid, commands are blocked until it is fixed.

This plugin gates Pi's built-in `bash` tool only. It is a lightweight permission check, not a sandbox or a guarantee of safety.

# auto-mode

A Pi plugin that automatically checks model-issued Bash commands before execution.

## Decision order

1. A deny pattern matching the full command or any command joined by `&&` or `|` blocks it.
2. A command joined by `&&` or `|` runs when every command matches an allow pattern.
3. Any other command matching an allow pattern runs it.
4. An unmatched command goes to a separate AI safety check.

The AI check uses Pi's active model and credentials, but creates a fresh request containing only a fixed classifier prompt, the working directory, and the command. It does not include or modify the current conversation. Only an exact `ALLOW` response runs the command; errors and all other responses block it. Decisions display the command in a green `✓` block for allow or a red `✗` block for deny, followed by `AI` or `REGEX` to identify the source.

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
  "deny": [
    "^git push --force$",
    "(^|\\s)(sudo|doas)(\\s|$)",
    "\\brm\\s+-rf\\b"
  ]
}
```

Rules from both files are combined. Each entry is a case-sensitive JavaScript regular expression tested against the full command after surrounding whitespace is removed. For commands joined by `&&` or pipelines using `|`, rules are also tested against each top-level command after surrounding whitespace is removed. Quoted and escaped operators are not separators. Use anchors such as `^git status$` for exact commands. Deny rules from either file take precedence. If both files are missing, all commands go to the AI check; if either file is invalid, commands are blocked until it is fixed.

This plugin gates Pi's built-in `bash` tool only. It is a lightweight permission check, not a sandbox or a guarantee of safety.

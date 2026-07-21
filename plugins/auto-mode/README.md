# auto-mode

A Pi plugin that automatically checks model-issued Bash commands before execution.

## Decision order

1. A matching deny pattern blocks the command.
2. A matching ask pattern requests user confirmation.
3. A command covered by allow patterns runs automatically.
4. Anything the patterns cannot safely decide goes to a separate AI safety check.

Policy matching checks the complete command, parsed shell-list elements, and recognized nested executable expansions. Deny rules always take precedence over ask and allow rules, and ask rules take precedence over allow rules. Regex allow is deliberately unavailable for shell syntax that cannot be split safely, including heredocs and executable expansions; those commands continue to the AI phase.

The AI check uses Pi's active session model and provider, but creates a fresh request containing only a fixed classifier prompt, the command, the canonical working and operating-system temporary directories, and host-resolved filesystem candidate metadata. It does not include or modify the current conversation. Symlinks, prospective new targets, long-option values, and environment assignments are canonicalized before the request. For `file:` values, both the literal-path and local-URL interpretations are provided because programs differ. The model determines which arguments and interpretations are actual filesystem targets; path-shaped regexes and other literal strings are not rejected just for looking like paths.

Some commands are blocked before a model request when their effects cannot be represented by trustworthy metadata. These include unresolved redirections, dynamic executable names, current-shell directory or code changes, malformed or executable-expanding heredocs, and recognized forms of inline interpreter code, alternate working-directory modes, and indirect command, response, or list sources. An exact `ALLOW` response runs the command, `ASK` requests user confirmation, and `DENY` blocks it. Errors, invalid responses, declined confirmations, and ask decisions without an available UI also block the command. Decisions display the command in a green `✓` block for allow or a red `✗` block for deny, followed by `AI` or `REGEX` to identify the source.

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

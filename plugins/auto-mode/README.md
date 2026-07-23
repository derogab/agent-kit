# auto-mode

A Pi plugin that checks model-issued Bash commands before execution using explicit policy rules and [SingGuard-NSFA-9B](https://huggingface.co/inclusionAI/SingGuard-NSFA-9B-GGUF).

> **WARNING**: this plugin is under active development and must be considered alpha software. Use it with caution.

## Overview

Auto-mode adds an optional safety check to Pi's built-in `bash` tool. It combines user-defined policy rules with a local classifier for commands not covered by those rules.

## Install

```bash
pi install npm:@derogab/pi-auto-mode
```

Run the local classifier and keep it available while using Pi:

```bash
llama-server \
  --host 127.0.0.1 \
  --port 8080 \
  --hf-repo inclusionAI/SingGuard-NSFA-9B-GGUF:Q4_K_M
```

The local server must remain available while auto-mode is on.

## Configure

Create `auto-mode.json` in either or both locations:

- Pi's user agent directory, normally `~/.pi/agent/auto-mode.json`
- The trusted project's `.pi/auto-mode.json`

```json
{
  "allow": [
    "^git status$",
    "^git diff$",
    "^npm test$",
    "^npm run (lint|build)$"
  ],
  "ask": [
    "^git push(?:\\s|$)",
    "^npm publish(?:\\s|$)"
  ],
  "deny": [
    "(^|\\s)(sudo|doas)(\\s|$)",
    "^git push .*?(--force(?:-with-lease)?|-f)(?:=\\S+)?(?:\\s|$)",
    "^rm -(rf|fr)(?:\\s|$)"
  ]
}
```

Use `allow` for commands that may run automatically, `ask` for commands that require confirmation, and `deny` for commands that must be blocked.

Rules from both files are combined. Each entry is a case-sensitive JavaScript regular expression, and more restrictive rules take priority. Keep allow rules narrow. If both files are missing, commands are checked by the classifier; if either file is invalid, commands are blocked.

Auto-mode is not a sandbox or a guarantee of safety.

The classifier uses SingGuard-NSFA-9B by the SingGuard Team at Ant Group's AI Security Lab, released under the Apache 2.0 license.

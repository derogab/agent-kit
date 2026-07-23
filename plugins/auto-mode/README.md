# auto-mode

A Pi plugin that checks model-issued Bash commands before execution using explicit policy rules and [SingGuard-NSFA-9B](https://huggingface.co/inclusionAI/SingGuard-NSFA-9B-GGUF).

> **WARNING**: this plugin is under active development and must be considered alpha software. Use it with caution.

## How it works

1. A matching deny pattern blocks the command.
2. A matching ask pattern requests user confirmation.
3. A command covered by allow patterns runs automatically.
4. Anything else goes to the model classifier.

Deny rules take precedence over ask and allow rules, and ask rules take precedence over allow rules. The classifier allows only `No_Risk`; risk labels, malformed output, and other errors block the command.

Auto-mode only checks the command while making this decision. It does not execute or rewrite it. When active, it shows `auto-mode` in Pi's status line using the theme's success color.

Use `/auto-mode` for help, `/auto-mode off` to bypass both checks, and `/auto-mode on` to enable them. If the model is not in Hugging Face's standard cache, enabling asks before downloading it (about 5.6 GB).

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

Rules from both files are combined. Each entry is a case-sensitive JavaScript regular expression. Keep allow rules narrow because matching commands skip the classifier. If both files are missing, all commands use the classifier; if either file is invalid, commands are blocked.

This plugin gates Pi's built-in `bash` tool only. It is not a sandbox or a guarantee of safety.

The classifier uses SingGuard-NSFA-9B by the SingGuard Team at Ant Group's AI Security Lab, released under the Apache 2.0 license.

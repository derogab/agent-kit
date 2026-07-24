# auto-mode

A Pi plugin that adds an optional safety check to Pi's built-in `bash` tool using explicit policy rules and a local classifier for commands not covered by those rules.

> **WARNING**: this plugin is under active development and must be considered alpha software. Use it with caution.

## Install

```bash
pi install npm:@derogab/pi-auto-mode
```

Install [`llama-server`](https://github.com/ggml-org/llama.cpp) and make it available on your `PATH`.
Auto-mode starts and maintains it in the background on an available local port
while enabled, downloading the selected model to the Hugging Face cache when needed.

## Controls

Run `/auto-mode` to manage the plugin settings.

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

The classifier uses the [0.8B](https://huggingface.co/inclusionAI/SingGuard-NSFA-0.8B-GGUF), [2B](https://huggingface.co/inclusionAI/SingGuard-NSFA-2B-GGUF), [4B](https://huggingface.co/inclusionAI/SingGuard-NSFA-4B-GGUF), or [9B](https://huggingface.co/inclusionAI/SingGuard-NSFA-9B-GGUF) SingGuard-NSFA model by the SingGuard Team at Ant Group's AI Security Lab, released under the Apache 2.0 license.

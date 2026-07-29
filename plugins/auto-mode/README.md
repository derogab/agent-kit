# auto-mode

A Pi plugin that adds an optional safety check to Pi's built-in `bash` tool using explicit policy rules and a local classifier for commands not covered by those rules.

> **WARNING**: this plugin is under active development and must be considered alpha software. Use it with caution.

## Install

```bash
pi install npm:@derogab/pi-auto-mode
```

Install the unified [`llama`](https://llama.app/) CLI and make it available on your `PATH`.
Auto-mode starts and maintains `llama serve` in the background on an available local port
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
    "^git commit\\b.*$",
    "^git push\\b.*$",
    "^npm publish\\b.*$"
  ],
  "deny": [
    "^git push(?=\\s|$)(?=[\\s\\S]*\\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force(?:-with-lease)?(?:=\\S+)?)(?:\\s|$))",
    "(^|\\s)(sudo|doas)(\\s|$)",
    "\\brm\\b(?=[\\s\\S]*\\s(?:-[a-zA-Z]*[rR][a-zA-Z]*|--(?:r|re|rec|recu|recur|recurs|recursi|recursiv|recursive))(?:\\s|$))(?=[\\s\\S]*\\s(?:-[a-zA-Z]*f[a-zA-Z]*|--(?:f|fo|for|forc|force))(?:\\s|$))"
  ]
}
```

Rules are checked in order: `deny`, `ask`, `allow`, then the classifier. Each rule is a case-sensitive JavaScript regular expression matched as written against the command. Rules from both files are combined. Missing files are ignored; invalid files block commands.

Auto-mode is not a sandbox or a guarantee of safety.

The classifier uses the [0.8B](https://huggingface.co/inclusionAI/SingGuard-NSFA-0.8B-GGUF), [2B](https://huggingface.co/inclusionAI/SingGuard-NSFA-2B-GGUF), [4B](https://huggingface.co/inclusionAI/SingGuard-NSFA-4B-GGUF), or [9B](https://huggingface.co/inclusionAI/SingGuard-NSFA-9B-GGUF) SingGuard-NSFA model by the SingGuard Team at Ant Group's AI Security Lab, released under the Apache 2.0 license.

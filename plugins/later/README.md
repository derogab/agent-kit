# later

A Pi plugin that adds `/later` to save prompts and run them later in the session.

## Install

### Pi

Install the plugin from npm:

```bash
pi install npm:@derogab/pi-later
```

## Usage

- `/later <prompt>`: save a prompt for later.
- `/later`: open the list of saved prompts. Pick one, then choose what to do with it:
  - **Confirm**: send the prompt to the session and run it; the prompt is removed from the list.
  - **Remove**: delete the prompt from the list without running it.

  Pressing <kbd>Esc</kbd> on either dialog leaves the list unchanged.

After the session's first assistant response, saved prompts survive `/reload` and session resume.

## Limitations

- Pi creates a new session file only after its first assistant response. Prompts saved before that point remain in memory and are lost if Pi exits or replaces the session with `/new`, `/resume`, or `/fork` first.

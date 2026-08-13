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
- `/later`: open the list of saved prompts. Pick one to send it to the session and run it; the prompt is removed from the list.

Saved prompts are stored in the session, so they survive `/reload` and session resume.

## Limitations

- Pi writes a new session to disk only after its first assistant response. Prompts saved before that point are kept in memory and lost if Pi exits first.

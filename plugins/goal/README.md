# goal

A Pi plugin that adds `/goal` to keep working until a goal is reached.

## Install

### Pi

Requires Pi 0.99.2 or newer. Install the plugin from npm:

```bash
pi install npm:@derogab/pi-goal
```

## Usage

- `/goal <objective>`: start a goal while Pi is idle.
- `/goal`: show the active goal and current round.
- `/goal stop`: cancel the goal and abort the current work.

For example:

```text
/goal Fix the failing tests without skipping or removing any, then run the full suite to verify.
```

Pi keeps working and checking its progress until it reports completion or a blocker that needs your input. The status bar shows the current round. Normal tool permissions still apply.

Pressing <kbd>Esc</kbd> to abort also stops the loop. Errors, session changes, tree navigation, and `/reload` stop it too. Start another goal explicitly when ready; goals do not resume automatically.

## Limitations

- Completion is assessed by the agent, not an independent verifier. Use clear, testable objectives and review the result.
- There is no iteration or spending limit. An unclear or impossible goal can keep consuming tokens until you stop it.
- Only one goal can run at a time. Goals are not saved across restarts.

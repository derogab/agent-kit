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
- `/goal-status`: show the current goal and progress.
- `/goal-pause`: pause the goal, abort its work, and keep it saved for later.
- `/goal-resume`: continue the saved goal.
- `/goal-stop`: stop the goal, abort its work, and archive it.
- `/goal-review`: resume, keep, or confirm and delete ended goals.

For example:

```text
/goal Fix the failing tests without skipping or removing any, then run the full suite to verify.
```

Pi keeps working and checking its progress until it reports completion or a blocker that needs your input. A small box above the editor shows the objective, status, completed-task count, round, and checklist. The first ten tasks appear on compact lines: `·` for pending and `✓` for completed. Longer checklists show an omitted-task count; the full checklist stays saved. The agent updates the checklist as it works. Normal tool permissions still apply.

Pressing <kbd>Esc</kbd>, errors, session changes, tree navigation, and `/reload` pause the goal without losing saved progress. In another session, run `/goal-resume` from the same project directory. Goals never resume automatically.

When the agent reports completion, the goal stays visible as awaiting review. Only your confirmation through `/goal-review` deletes it. You can start another goal while older ones await review.

## Saved goals

Files live under the directory where you start Pi:

- `.pi/goals/current.json`: the current objective, status, round, and checklist.
- `.pi/goals/archive/`: completed or stopped goals awaiting your review, not permanent history.

Blocked and paused goals stay in `current.json`. Confirmed goals leave no saved goal file. These files do not contain the conversation; on resume, Pi uses the objective, checklist, and workspace to continue.

Add `.pi/goals/` to your project's `.gitignore` if you want the files to stay local.

## Limitations

- Progress and completion are assessed by the agent, not an independent verifier. Use clear, testable objectives and review the result.
- There is no iteration or spending limit. An unclear or impossible goal can keep consuming tokens until you stop it.
- Use one goal session per project at a time; simultaneous sessions are not coordinated.
- The graphical box requires terminal mode. Reviewing goals requires an interactive UI; RPC clients receive a plain-text widget.

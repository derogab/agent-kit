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
- `/goal-status`: show the current goal and progress, or the latest archived goal when none is active.
- `/goal-pause`: pause the goal, abort its work, and keep it saved for later.
- `/goal-resume`: continue the saved goal.
- `/goal-stop`: stop the goal, abort its work, and archive it.

For example:

```text
/goal Fix the failing tests without skipping or removing any, then run the full suite to verify.
```

Pi keeps working and checking its progress until it reports completion or a blocker that needs your input. A small box above the editor shows the objective, status, completed-task count, round, and checklist. The first ten tasks appear on compact lines: `·` for pending and `✓` for completed. Longer checklists show an omitted-task count; the full checklist stays saved. For checklists with more than ten tasks in terminal mode, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> to expand the full checklist. Use the up/down arrow keys or <kbd>Page Up</kbd>/<kbd>Page Down</kbd> to scroll, and press the shortcut again or <kbd>Esc</kbd> to collapse it. The expanded list also works for paused goals and the latest archived goal. The agent updates the checklist as it works. Normal tool permissions still apply.

You can steer a running goal: submit a message with <kbd>Enter</kbd> to give corrections or extra context at the next turn boundary, without pausing the goal. The agent is instructed to apply your newer instructions and update its checklist rather than blindly repeat the original objective. Queued input takes priority over declaring the goal complete or blocked. For less urgent input, use Pi's follow-up action (<kbd>Alt</kbd>+<kbd>Enter</kbd> by default on macOS/Linux), which waits until the agent would otherwise stop; it does not need to wait for the whole goal to finish.

Pressing <kbd>Esc</kbd> outside the expanded checklist, errors, session changes, tree navigation, and `/reload` pause the goal without losing saved progress. In another session, run `/goal-resume` from the same project directory. Goals never resume automatically.

When the agent reports completion, Pi announces that the goal was reached, marks its checklist complete, and automatically archives it. After the final recap, the goal box and any open expanded checklist disappear. Use `/goal-status` to check the archived goal. No review or confirmation is needed. Stopping a goal archives it as `stopped` without marking unfinished tasks complete.

## Saved goals

Files live under the directory where you start Pi:

- `.pi/goals/current.json`: the current objective, status, round, and checklist.
- `.pi/goals/archive/`: completed or stopped goals retained as history, including goals saved by earlier versions.

Blocked and paused goals stay in `current.json` and can be resumed with `/goal-resume`. Archived goals are not resumed or deleted by the plugin; start a new goal for further work. When no goal is active, the latest archive and its checklist remain visible only if that goal was stopped; completed goals stay hidden, including after a restart. These files do not contain the conversation; on resume, Pi uses the objective, checklist, and workspace to continue.

If archiving fails, Pi reports an error and keeps the goal saved. Fix the storage problem, then use `/goal-status` or restart Pi to retry archiving without re-running the goal.

Add `.pi/goals/` to your project's `.gitignore` if you want the files to stay local.

## Limitations

- Progress and completion are assessed by the agent, not an independent verifier. Use clear, testable objectives and review the result.
- There is no iteration or spending limit. An unclear or impossible goal can keep consuming tokens until you stop it.
- Use one goal session per project at a time; simultaneous sessions are not coordinated.
- The graphical box requires terminal mode; RPC clients receive a plain-text widget. Automatic completion and archiving also work without an interactive UI.

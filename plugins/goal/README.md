# goal

A Pi plugin that adds `/goal` to keep working until a goal is reached.

## Install

### Pi

Requires Pi 0.99.2 or newer. Install the plugin from npm:

```bash
pi install npm:@derogab/pi-goal
```

## Usage

- `/goal <objective>`: start a goal in the current Pi session while it is idle.
- `/goal-status`: show this session's current goal and progress, or its latest archived goal when none is active.
- `/goal-pause`: pause the goal, abort its work, and keep it saved until `/goal-resume`. Also prevents a blocked goal from resuming on a reply.
- `/goal-resume`: continue this session's paused or blocked goal.
- `/goal-stop`: stop the goal, abort its work, and archive it.

For example:

```text
/goal Fix the failing tests without skipping or removing any, then run the full suite to verify.
```

Each Pi session has its own goal and history. Open separate sessions in the same repository to work toward different goals in parallel; starting, pausing, stopping, or completing one does not affect the others.

Pi keeps working and checking its progress until it reports completion or a blocker that needs your input. A small box above the editor shows the objective, status, completed-task count, round, and checklist. The first ten tasks appear on compact lines: `·` for pending and `✓` for completed. Longer checklists show an omitted-task count; the full checklist stays saved. For checklists with more than ten tasks in terminal mode, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> to expand the full checklist. Use the up/down arrow keys or <kbd>Page Up</kbd>/<kbd>Page Down</kbd> to scroll, and press the shortcut again or <kbd>Esc</kbd> to collapse it. The expanded list also works for paused goals and the latest archived goal. The agent updates the checklist as it works. Normal tool permissions still apply.

You can steer a running goal: submit a message with <kbd>Enter</kbd> to give corrections or extra context at the next turn boundary, without pausing the goal. The agent is instructed to apply your newer instructions and update its checklist rather than blindly repeat the original objective. Queued input takes priority over declaring the goal complete or blocked. For less urgent input, use Pi's follow-up action (<kbd>Alt</kbd>+<kbd>Enter</kbd> by default on macOS/Linux), which waits until the agent would otherwise stop; it does not need to wait for the whole goal to finish.

A `blocked` goal is waiting for your input, not manually paused. Reply normally to continue it automatically with its saved checklist; no `/goal-resume` is needed. If the blocker remains, Pi can report it again. You can also use `/goal-resume` after fixing something outside Pi. Extension-generated prompts do not unfreeze blocked goals. A `paused` goal requires `/goal-resume`, and a `stopped` goal stays archived.

Resuming during a request marks the goal as running immediately without interrupting that request or queuing another prompt. Pi continues toward the goal after the current work and queued input finish. Resuming an already-running goal does nothing.

Pressing <kbd>Esc</kbd> outside the expanded checklist, errors, session changes, tree navigation, and `/reload` pause running goals without losing saved progress. To return later, reopen the original Pi session with `/resume`, then use `/goal-resume`. Starting a new session or forking does not inherit another session's goal. Blocked goals stay blocked across reloads and can still continue on your next reply; reopening a session alone never starts work.

When the agent reports completion, Pi announces that the goal was reached, marks its checklist complete, and automatically archives it. After the final recap, the goal box and any open expanded checklist disappear. Use `/goal-status` to check the archived goal. No review or confirmation is needed. Stopping a goal archives it as `stopped` without marking unfinished tasks complete.

## Saved goals

- Active goals stay in `.pi/goals/sessions/session-<id>/current.json` under the directory where you start Pi.
- Completed and stopped goals go to `/tmp/pi-goals-<uid>/<workspace-hash>/session-<id>/` on macOS and Linux. On Windows, they go under `pi-goals` in the user's temporary directory. Each workspace and session has separate history. The OS may clear temporary files; copy archives elsewhere if you need to keep them.
- Existing per-session archives in `.pi/goals/sessions/session-<id>/archive/` remain readable in place. No new archives are written there.

Blocked and paused goals stay saved until resumed or stopped. Archived goals are not resumed or deleted by the plugin; start a new goal for further work. When no goal is active, this session's latest archive and its checklist remain visible only if that goal was stopped; completed goals stay hidden, including after a restart. These files do not contain the conversation; on resume, Pi uses the objective, checklist, and workspace to continue.

Goals saved by earlier versions in `.pi/goals/current.json` are left untouched until you run `/goal-resume` in a session without an active goal. That session adopts the old goal; other sessions cannot adopt it again. Older history in `.pi/goals/archive/` remains on disk but is not assigned to a session. Close Pi instances running the older plugin before adopting a shared goal.

If archiving fails, Pi reports an error and keeps the goal saved. Fix the storage problem, then use `/goal-status` or restart Pi to retry archiving without re-running the goal.

Add `.pi/goals/` to your project's `.gitignore` if you want the files to stay local.

## Limitations

- Progress and completion are assessed by the agent, not an independent verifier. Use clear, testable objectives and review the result.
- There is no iteration or spending limit. An unclear or impossible goal can keep consuming tokens until you stop it.
- Use distinct Pi sessions for parallel goals, not two processes reopening the same session. Goal state is isolated; edits to shared workspace files are not. Use separate worktrees when goals could modify the same files.
- The graphical box requires terminal mode; RPC clients receive a plain-text widget. Automatic completion and archiving also work without an interactive UI.

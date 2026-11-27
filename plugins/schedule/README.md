# schedule

A Pi plugin to run tasks at a future time, on a recurring interval, or when a matching event happens. Manage saved schedules and listeners, or create them through conversation.

## Install

### Pi

Install the plugin from npm:

```bash
pi install npm:@derogab/pi-schedule
```

For local development, load it from this repository:

```bash
pi -e ./plugins/schedule
```

## Usage

- `/schedule in 10m Review the test results`: run a prompt once after a delay.
- `/schedule every 1h Check the build status`: run a prompt at a fixed interval, starting after the first interval.
- `/schedule at 2030-01-01T09:00:00+02:00 Review the release checklist`: run a prompt once at a date/time. Include `Z` or a timezone offset.
- `/schedule on file created build/ready.txt -- Review the build results`: run once when a local path appears.
- `/schedule on file changed src/config.ts -- Run the relevant tests`: run once when a local path changes.
- `/schedule on file deleted build.lock -- Check the build results`: run once when a local path disappears.
- `/schedule on tool bash error -- Investigate the failed command`: run once after a matching Pi tool completion. The outcome (`any`, `success`, or `error`) is required in this direct form. Output filtering (`contains`) requires the `schedule` tool; it is not supported by the direct command.
- `/schedule tomorrow at noon remind me to review the PR`: ask Pi to interpret a natural-language request and save it using the scheduling tool. This needs a model and credentials; ambiguous requests may require clarification.
- `/schedule`: open the saved schedules. Pick one to **Pause**, **Resume**, or **Remove** it. Press <kbd>Esc</kbd> to leave it unchanged.

Durations accept seconds, minutes, hours, days, and weeks (`s`, `m`, `h`, `d`, `w`), with a minimum of one second. A day means 24 hours, not a calendar-day rule.

You can also ask normally, for example: “In 20 minutes, remind me to check the deployment,” “Listen for changes to src/config.ts, then run the tests,” or “When the next bash tool fails with output containing FAIL, investigate it.” Pi is instructed to use the `schedule` tool for future tasks and reminders without needing `/schedule`. The tool also supports listing, pausing, resuming, and removing schedules. Automatic interpretation depends on the model; a request is only saved after the tool succeeds.

The footer shows `⏲ schedule:` with the number of active and saved schedules. Due tasks and matched listeners wait until Pi is idle and has no pending messages, then run as ordinary prompts with the current model and normal tool permissions. Shell commands should be expressed as task prompts, such as `/schedule in 5m Run npm test`; the plugin does not bypass Pi to execute shell commands directly.

## Listeners

Listeners run **once**, on the next matching event after being armed. They do not run immediately just because a path already exists or a tool failed earlier. Use `/schedule` or the `schedule` tool to list, pause, resume, and remove them. The list shows what each listener watches and whether it is listening, triggered, or paused.

- **Local paths:** `created` means absent → present; `deleted` means present → absent; `changed` includes creation, deletion, replacement, and metadata changes. Paths are relative to the session working directory; absolute paths and `~/` also work. In direct commands, separate the path from the task with ` -- `; spaces in paths need no quotes. Paths are not globs, and directories are not watched recursively.
- **Pi tools:** match the exact tool name, optionally an outcome and a case-sensitive literal substring in a text output block. Success/error follows the tool's reported error status, not an interpretation of its output. All matching completions in this session count, including nested tool calls; the `schedule` tool itself cannot be watched. This includes command completions reported by Pi's `bash` tool. A listener does not start tools or independently monitor external processes, and it does not observe commands run outside Pi tools or in another session.
- **Safe execution:** only your saved task prompt runs, with normal Pi permissions. File contents and tool output do not become new instructions. Listening does not execute shell commands or call a model to evaluate conditions.

For example, Pi can save an output-filtered listener with:

```json
{
  "action": "add",
  "prompt": "Investigate the failed tests",
  "listen": {
    "kind": "tool",
    "name": "bash",
    "outcome": "error",
    "contains": "FAIL"
  }
}
```

For a path, use `"listen": { "kind": "file", "path": "build/ready.txt", "event": "created" }`. Supply exactly one of `listen`, `after`, `every`, or `at` when adding a task.

Listeners only observe events while this session is open and the listener is active. Pausing ignores new events; resuming starts listening afresh. A match already recorded before pausing or closing remains saved until its prompt starts. Reloading or returning to a branch starts unmatched listeners afresh; events during downtime are not replayed. Local paths are checked about once per second, so brief changes between checks can be missed, and a change does not guarantee a writer has finished. Repeated listeners, file-content conditions, websites, webhooks, and arbitrary external conditions are not supported; Pi should clarify unsupported requests rather than silently substituting a timer.

## Persistence and limitations

- Schedules belong to the current session branch. After the session's first assistant response, they survive `/reload` and session resume. `/new` does not carry them over; forks inherit their branch's schedules.
- Pi does not persist a new session until its first assistant response. Schedules saved before that point are in memory only and can be lost on exit or session replacement.
- Pi must be running with the relevant session open. There is no background service, OS scheduler, or wake-from-sleep support. Overdue schedules run after resuming that session, once Pi is idle.
- Recurring schedules skip missed intervals rather than replaying a backlog. Resuming an overdue paused schedule runs it once when idle. Calendar recurrence, cron expressions, and daily-at-a-clock-time rules are not supported.
- One-off schedules and matched listeners are removed, and recurring schedules advance, when their prompt starts—not when the task succeeds. Missing credentials or undelivered prompts leave the schedule saved for retry.
- Removing or pausing a schedule cannot retract a prompt already submitted to Pi. Retries, branch navigation, forks, or an interrupted save can replay a task; use idempotent tasks when repeat execution matters.
- Direct timed and listener commands work without a model when saving, but execution requires a model and credentials. The manager needs an interactive or RPC UI; the scheduling tool works without one.

# schedule

A Pi plugin to schedule future and recurring tasks, manage saved schedules, and recognize scheduling requests in conversation.

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
- `/schedule tomorrow at noon remind me to review the PR`: ask Pi to interpret a natural-language request and save it using the scheduling tool. This needs a model and credentials; ambiguous requests may require clarification.
- `/schedule`: open the saved schedules. Pick one to **Pause**, **Resume**, or **Remove** it. Press <kbd>Esc</kbd> to leave it unchanged.

Durations accept seconds, minutes, hours, days, and weeks (`s`, `m`, `h`, `d`, `w`), with a minimum of one second. A day means 24 hours, not a calendar-day rule.

You can also ask normally, for example: “In 20 minutes, remind me to check the deployment.” Pi is instructed to use the `schedule` tool for future tasks and reminders without needing `/schedule`. The tool also supports listing, pausing, resuming, and removing schedules. Automatic interpretation depends on the model; a request is only saved after the tool succeeds.

The footer shows `⏲ schedule:` with the number of active and saved schedules. Due tasks wait until Pi is idle and has no pending messages, then run as ordinary prompts with the current model and normal tool permissions. Shell commands should be expressed as task prompts, such as `/schedule in 5m Run npm test`; the plugin does not bypass Pi to execute shell commands directly.

## Persistence and limitations

- Schedules belong to the current session branch. After the session's first assistant response, they survive `/reload` and session resume. `/new` does not carry them over; forks inherit their branch's schedules.
- Pi does not persist a new session until its first assistant response. Schedules saved before that point are in memory only and can be lost on exit or session replacement.
- Pi must be running with the relevant session open. There is no background service, OS scheduler, or wake-from-sleep support. Overdue schedules run after resuming that session, once Pi is idle.
- Recurring schedules skip missed intervals rather than replaying a backlog. Resuming an overdue paused schedule runs it once when idle. Calendar recurrence, cron expressions, and daily-at-a-clock-time rules are not supported.
- One-off schedules are removed, and recurring schedules advance, when their prompt starts—not when the task succeeds. Missing credentials or undelivered prompts leave the schedule saved for retry.
- Removing or pausing a schedule cannot retract a prompt already submitted to Pi. Retries, branch navigation, forks, or an interrupted save can replay a task; use idempotent tasks when repeat execution matters.
- Direct timed commands work without a model when saving, but execution requires a model and credentials. The manager needs an interactive or RPC UI; the scheduling tool works without one.

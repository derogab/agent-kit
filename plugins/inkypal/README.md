# inkypal

A plugin that notifies [InkyPal](https://github.com/derogab/inkypal) on lifecycle events.

## Events

| Hook | Face | Message |
|------|------|---------|
| `Stop` | tone-matched | `<last user prompt> -> <last assistant text>` |
| `SubagentStop` | `cool` | last subagent text |
| `Notification` | `alert` | the notification message (e.g. permission request) |

Messages are sent with `bypass_ai: true` so InkyPal shows the raw text without AI rewriting.

## Configuration

Set the following environment variables:

- `INKYPAL_HOST`: the InkyPal host (e.g. `192.168.1.50`)
- `INKYPAL_PORT`: the InkyPal port (e.g. `8080`)
- `INKYPAL_API_KEY` (optional): bearer token sent as `Authorization: Bearer <key>` when InkyPal is configured to require authentication.

If either `INKYPAL_HOST` or `INKYPAL_PORT` is unset, the hook does nothing.

## Install

### Claude Code

```bash
claude plugin marketplace add derogab/agent-kit
claude plugin install inkypal@agent-kit
```

# inkypal

A plugin that notifies [InkyPal](https://github.com/derogab/inkypal) when a task finish.

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

---
name: list-issues
description: Organize and update code-related issues in a consistent table with stable issue IDs, type, concise file-and-line-aware descriptions, and current status. Use when code review findings, bugs, risks, or suggestions need to be listed, summarized, tracked, or updated during a conversation.
---

# List Issues

Present code issues as a table using the representation supported by the active agent or interface. Use exactly these columns in order: `Issue ID`, `Type`, `Description`, and `Status`.

## Build the Table

1. Assign IDs in discovery order as `I1`, `I2`, `I3`, and so on.
2. Keep each ID bound to the same underlying issue across every table update. Match by the concern and location, not by exact wording or row position.
3. Never renumber or reuse an ID. Assign each new issue the number after the highest ID already used in the conversation.
4. Keep addressed issues in full-table updates and change only their status. If the user requests a filtered view, omit excluded rows but reserve their IDs.
5. Order rows by the numeric part of the issue ID to minimize churn between updates.

## Fill the Columns

- **Issue ID**: Use the issue's stable `I<number>` identifier.
- **Type**: Use `Critical`, `Important`, `Minor`, or `Suggestion`.
  - `Critical`: Security, data loss, severe correctness, or release-blocking risk.
  - `Important`: A meaningful defect or risk that should be addressed.
  - `Minor`: A limited-impact problem or maintainability concern.
  - `Suggestion`: An optional improvement with no current defect.
- **Description**: Write one short, clear sentence that explains the problem and its impact. Include a known source location as `` `path/to/file.ext:line` ``; omit the location rather than guessing it. Keep the description on one line.
- **Status**: Use `Open`, `Fixed`, `Won't Fix`, or `False Positive`. Default new issues to `Open`, and preserve an explicit status supplied by the user.

## Update Existing Issues

- Update the existing row when its wording, type, location, or status changes without changing the underlying issue.
- Create a new ID when a finding has a materially different cause or impact, even if it is near an existing issue.
- Keep the earliest ID when duplicate findings are consolidated, and mark the later duplicate as `False Positive` rather than removing or reusing its ID.
- Do not add a separate file or line column; keep source references in the description.

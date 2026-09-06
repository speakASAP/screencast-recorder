# Validation Debt Ledger

## Purpose

Record known validation failures that are not caused by the active task.

## Rules

- Validation debt never excuses a current-task failure.
- Every entry requires an owner, scope and unblock condition.
- Do not include secrets, tokens, raw production data or private evidence.
- Promote an entry to an active blocker when it affects changed files,
  acceptance criteria or required integrations.

## Entries

No validation debt recorded.

## Update format

When debt exists, add a table with: ID, date, command, sanitized failure,
scope, owner, current-task impact, unblock condition and evidence path.

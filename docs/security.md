# Security And Safety Model

Zotero plugins run with high local privileges. This bridge is designed around explicit, narrow operations instead of arbitrary code execution.

## Rules

- Do not expose an arbitrary JavaScript execution operation.
- Do not edit `zotero.sqlite` directly.
- Do not mutate attachment `linkMode` in place.
- Do not delete external linked files as a side effect of deleting Zotero records.
- Do not perform fuzzy or title-based deletion.
- Prefer `dry-run` before `apply` for all write operations.
- Permanent deletion must target exact item keys already in Zotero Trash.

## Operation Classes

- Read-only: safe to run by default.
- Write: requires `mode`.
- Destructive: requires exact keys and dry-run review.
- Heavy: may inspect many files and should support limits or pagination.

## Reports

Batch and destructive operations should include:

- request id
- operation
- mode
- plugin version
- Zotero version
- start and finish time
- target keys or filters
- summary counts
- skipped items with reasons
- failures with error messages

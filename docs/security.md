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
- Batch cleanup must produce explicit keep/remove plans before `apply`.
- Duplicate attachment cleanup must not hash the whole library. It first narrows candidates by same parent item, same content type, and same file size.

## Operation Classes

- Read-only: safe to run by default.
- Write: requires `mode`.
- Destructive: requires exact keys and dry-run review.
- Heavy: may inspect many files and should support limits or pagination.

## Boundaries

The bridge is deliberately not:

- a paper downloader
- a publisher crawler
- a DOI/Crossref metadata fetcher
- a general local automation or arbitrary JavaScript endpoint
- a tool for deleting cloud or external attachment files

Clients can fetch metadata or files externally, validate them, and then ask the bridge to write exact Zotero records or attachment links.

## Duplicate Attachment Cleanup

`find-duplicate-attachments` and `cleanup-duplicate-attachments` use conservative exact and probable rules:

1. Compare only attachments under the same parent Zotero item.
2. Require the same content type.
3. Exact matches require the same file size and same SHA-256; only exact-size candidates are hashed.
4. Probable matches require the same attachment kind, such as primary, supplementary, snapshot, media, or data.
5. Probable matches also require near file size plus title/name evidence or a tiny size delta.
6. Possible matches can report multiple same-parent primary files with larger size/name differences, but they are review-only.
7. Trash only extra Zotero attachment records in `apply`; review-only possible matches are not included in `removeKeys`.

External linked files are never removed by this operation.

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

# Zotero Management API Draft

This document describes the intended public API surface. Operation names are stable only after `v1.0`.

## Request Shape

```json
{
  "id": "optional-client-request-id",
  "operation": "status",
  "mode": "dry-run",
  "args": {},
  "reportMode": "summary"
}
```

`mode` is ignored for read-only operations. Write operations default to `dry-run`.

## Query Operations

- `status`: plugin version, Zotero version, queue root, configured linked-attachment root.
- `capabilities`: list supported operations and argument requirements.
- `list-collections`: collection tree with keys, names, parent keys, and paths.
- `search-items`: metadata search by DOI, title, creator, year, collection, tag, item type.
- `get-items`: full item metadata by key.
- `get-item-children`: child attachments, notes, and annotations for item keys.
- `list-attachments`: attachment inventory with link mode and content type filters.
- `inspect-attachments`: resolved paths, file existence, stored/linked classification.
- `find-missing-attachments`: Zotero attachments whose target files are absent.
- `find-duplicates`: candidate duplicate items or attachments by DOI, title/year, or path.
- `recent-items`: recently added or modified items and attachments.

## Execute Operations

- `create-item`: create a Zotero item from structured metadata.
- `update-item-fields`: update whitelisted item fields and creators by key.
- `create-collection`: create a collection under an optional parent.
- `move-to-collection`: add/remove items from collections.
- `add-tags` / `remove-tags`: tag management.
- `link-file-to-item`: create a linked-file attachment.
- `import-file-to-item`: import a stored-file attachment, only when explicitly needed.
- `trash-items-by-key`: move exact item keys to Zotero Trash.
- `erase-trash-by-key`: permanently erase exact keys already in Zotero Trash.

## Guard Operations

- `preflight`: validate an intended write operation before dry-run/apply.
- `validate-file`: check file existence, content type, extension, and optional PDF header.
- `dry-run-plan`: return an explicit plan for batch operations.
- `verify-after-apply`: verify that a completed write produced the expected state.

## Maintenance Operations

- `copy-stored-to-cloud`: copy Zotero stored files to a configured linked-attachment root.
- `create-linked-copies`: create linked-file records for copied files.
- `cleanup-old-stored`: trash old stored attachments only when safe linked copies exist.
- `repair-attachment-paths`: repair linked attachment records whose files exist at expected relative paths.

## Report Modes

- `none`: return only the response.
- `summary`: return a compact response; write no file unless the client archives it.
- `full`: include full details and allow the client/plugin to persist a report.

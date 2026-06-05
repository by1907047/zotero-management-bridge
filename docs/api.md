# Zotero Management API

Operation names are stable for the `v0.3.0-beta.1` community trial, but may still change before `v1.0`.

## Request Shape

```json
{
  "id": "optional-client-request-id",
  "operation": "status",
  "mode": "dry-run",
  "args": {}
}
```

`mode` is ignored for read-only operations. Write-capable operations should be run with `dry-run` first and then repeated with `apply` only after the plan is reviewed.

## Safety Levels

| Level | Meaning |
| --- | --- |
| read-only | Does not change Zotero or files. |
| dry-run-first | Can change Zotero or copy/import files in `apply`; returns a plan in `dry-run`. |
| destructive-exact-key | Can remove Zotero records only by exact keys. External linked files are not deleted. |

## Query Operations

### `status`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{"operation":"status","mode":"dry-run","args":{}}
```

Response includes Zotero version, plugin version, queue root, configured cloud base, and user library id.

### `capabilities`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{"operation":"capabilities","args":{}}
```

Response lists supported operations and safety flags such as `arbitraryJavaScript:false` and `deletesExternalLinkedFiles:false`.

### `list-collections`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{"operation":"list-collections","args":{}}
```

Returns collection ids, keys, names, parent ids, and display paths.

### `search-items`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{
  "operation": "search-items",
  "args": {
    "query": "flow sensor",
    "itemType": "journalArticle",
    "year": "2024",
    "limit": 25
  }
}
```

Supported filters: `query`, `DOI` or `doi`, `itemType`, `year`, `limit`.

### `get-items`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{"operation":"get-items","args":{"keys":["ABCD1234"]}}
```

Returns item metadata, creators, collections, tags, and common bibliographic fields.

### `get-item-children`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{"operation":"get-item-children","args":{"keys":["ABCD1234"]}}
```

Returns child attachments and notes for each parent item key.

### `list-attachments`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{
  "operation": "list-attachments",
  "args": {
    "category": "linked-file",
    "contentType": "application/pdf"
  }
}
```

Supported filters: `category` (`linked-file`, `stored-file`, `html-snapshot`, `linked-url`, `other`) and `contentType`.

### `metadata-audit`

Safety: read-only. Changes Zotero: no. Touches external files: no.

```json
{
  "operation": "metadata-audit",
  "args": {
    "itemTypes": ["journalArticle", "conferencePaper"]
  }
}
```

Finds missing `title`, `DOI`, `date`, `publicationTitle` or `proceedingsTitle`, and `creators`. DOI is required by default only for journal articles and conference papers, not theses or books.

### `find-duplicate-attachments`

Safety: read-only, but it reads candidate attachment files to compute SHA-256 hashes for exact-size candidates and file sizes for near-size candidates. Changes Zotero: no. Deletes external files: no.

```json
{
  "operation": "find-duplicate-attachments",
  "args": {
    "maxHashCandidateAttachments": 200,
    "enableNearDuplicateAttachments": true,
    "nearDuplicateMaxSizeDeltaBytes": 8192,
    "nearDuplicateMaxSizeDeltaRatio": 0.01
  }
}
```

Duplicate rule:

1. File attachments are considered. Linked files and HTML snapshots are included by default; stored non-snapshot files are included only with `includeStoredFiles:true`.
2. Exact duplicates are grouped by same parent item, same content type, same file size, and same SHA-256. SHA-256 is computed only for exact-size candidates.
3. Probable duplicates are grouped by same parent item, same content type, same attachment kind, and near file size. Attachment kinds include `primary`, `supplementary`, `snapshot`, `media`, and `data`.
4. Near-size probable matches require additional evidence: same/generic title, strong token overlap, or a tiny size delta. Main article attachments are not mixed with supplementary files, and snapshots are compared only with snapshots.
5. The keep/remove plan prefers descriptive titles over generic titles such as `PDF`, `Full Text PDF`, `Snapshot`, and `\u5168\u6587`.

Response includes `duplicateGroups`, `confidence` (`exact` or `probable`), `evidenceType`, `keep`, `remove`, scores, reasons, skipped files, and summary counts.

## Write Operations

### `update-item-fields`

Safety: dry-run-first. Changes Zotero in `apply`: yes. Touches external files: no.

```json
{
  "operation": "update-item-fields",
  "mode": "dry-run",
  "args": {
    "updates": [
      {
        "key": "ABCD1234",
        "fields": {
          "DOI": "10.1234/example",
          "publicationTitle": "Example Journal"
        }
      }
    ]
  }
}
```

Updates only explicit keys and explicit fields. The bridge does not fetch Crossref, DOI, publisher, or web metadata; clients should fetch and verify metadata before sending this operation.

### `link-file-to-item`

Safety: dry-run-first. Changes Zotero in `apply`: creates linked attachment record. Touches external files: reads path existence only; does not copy or delete.

```json
{
  "operation": "link-file-to-item",
  "mode": "dry-run",
  "args": {
    "parentKey": "ABCD1234",
    "filePath": "D:/ZoteroLinked/storage/ABCD1234/paper.pdf",
    "title": "Full Text PDF",
    "contentType": "application/pdf"
  }
}
```

### `import-file-to-item`

Safety: dry-run-first. Changes Zotero in `apply`: imports a stored attachment. Touches external files: Zotero copies/imports the source file.

Use this only when a stored attachment is explicitly desired.

### `copy-stored-to-cloud`

Safety: dry-run-first. Changes Zotero: no. Touches external files in `apply`: copies or moves stored files to `cloudBase`.

```json
{"operation":"copy-stored-to-cloud","mode":"dry-run","args":{"cloudBase":"D:/ZoteroLinked"}}
```

### `create-linked-copies`

Safety: dry-run-first. Changes Zotero in `apply`: creates linked attachment records. Touches external files: checks files exist but does not delete.

```json
{"operation":"create-linked-copies","mode":"dry-run","args":{"cloudBase":"D:/ZoteroLinked"}}
```

### `cleanup-old-stored`

Safety: dry-run-first. Changes Zotero in `apply`: moves old stored attachment records to Trash when matching linked copies exist and no notes/annotations are attached. Deletes external files: no.

```json
{"operation":"cleanup-old-stored","mode":"dry-run","args":{"cloudBase":"D:/ZoteroLinked"}}
```

### `cleanup-duplicate-attachments`

Safety: dry-run-first. Changes Zotero in `apply`: moves duplicate attachment records to Trash. Deletes external files: no.

```json
{
  "operation": "cleanup-duplicate-attachments",
  "mode": "dry-run",
  "args": {
    "maxHashCandidateAttachments": 200
  }
}
```

`apply` runs the same candidate plan, then trashes only the listed extra Zotero attachment records. It never permanently erases records and never deletes cloud-synced or other linked files.

### `trash-items-by-key`

Safety: destructive-exact-key. Changes Zotero in `apply`: moves exact item keys to Trash. Deletes external files: no.

```json
{"operation":"trash-items-by-key","mode":"dry-run","args":{"keys":["ABCD1234"]}}
```

### `erase-trash-by-key`

Safety: destructive-exact-key. Changes Zotero in `apply`: permanently erases exact keys that are already in Zotero Trash. Deletes external linked files: no.

```json
{"operation":"erase-trash-by-key","mode":"dry-run","args":{"keys":["ABCD1234"]}}
```

## CLI Generic Request Entry

The CLI supports operation-specific shortcut flags plus a generic JSON argument entry:

```powershell
python cli/zotero_bridge.py plugin-request --operation metadata-audit --args-json '{"itemTypes":["journalArticle"]}' --wait
```

For longer requests, store args in a file and pass `@path`:

```powershell
python cli/zotero_bridge.py plugin-request --operation update-item-fields --mode dry-run --args-json '@request-args.json' --wait
```

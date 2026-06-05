# Zotero Management Bridge

Zotero Management Bridge is a local Zotero plugin plus CLI helper that exposes a controlled management API for automation agents and scripts.

The bridge is intentionally not a web scraper, downloader, or arbitrary JavaScript runner. It runs inside Zotero and provides whitelisted query, execution, verification, and reporting operations against the local Zotero library.

## Goals

- Let local agents manage Zotero through Zotero's own JavaScript API.
- Keep dangerous actions explicit, auditable, and dry-run first.
- Support linked-attachment workflows without mutating `linkMode` in place.
- Return structured JSON by default and write reports only when requested or useful.

## API Layers

- `query-*`: status, capabilities, collections, item search, item details, children, attachments, missing files, duplicates, recent items.
- `execute-*`: create/update items, collections, tags, attachment links, trash by key, erase trash by key.
- `guard-*`: preflight, dry-run plans, file validation, post-apply verification.
- `maintenance-*`: stored-file to cloud copy, linked-copy creation, old stored attachment cleanup, path repair.
- `report-*`: structured responses and optional JSON reports for batch or dangerous operations.

## Current Seed Operations

The initial alpha is seeded from a locally validated bridge and currently includes:

- `status`
- `inspect`
- `copy-stored-to-cloud`
- `create-linked-copies`
- `cleanup-old-stored`
- `link-file-to-item`
- `import-file-to-item`
- `trash-items-by-key`
- `erase-trash-by-key`

More query and CRUD operations are planned in `docs/api.md`.

## Safety Model

- No arbitrary JavaScript execution endpoint.
- No direct SQLite writes.
- No in-place attachment `linkMode` mutation.
- Dangerous operations support `dry-run`.
- Permanent erase operations must target exact Zotero keys.
- External linked files are not deleted just because Zotero items are deleted.

## Configuration

The plugin reads these Zotero preferences:

- `extensions.zoteroManagementBridge.queueRoot`
- `extensions.zoteroManagementBridge.cloudBase`
- `extensions.zoteroManagementBridge.reportMode`
- `extensions.zoteroManagementBridge.intervalMs`

If `queueRoot` is unset, the plugin uses a queue under the Zotero profile directory.

See `examples/config.example.json`.

## Packaging

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

The generated `.xpi` appears under `dist/`.

## Updates

Installed builds can update through Zotero when `manifest.json` points to a hosted `updates.json`.

This repository uses:

```text
https://raw.githubusercontent.com/by1907047/zotero-management-bridge/main/updates.json
```

Release assets should be uploaded to GitHub Releases, and `updates.json` should point to the matching `.xpi` with a SHA-256 `update_hash`.

## Compatibility

Target: Zotero 7+ manifest format, tested locally against Zotero 9.

Zotero plugins have full access to Zotero and local files. Install only code you trust.

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

## Install

1. Download the `.xpi` from the latest GitHub Release.
2. Open Zotero -> Tools -> Plugins.
3. Choose "Install Plugin From File..." and select the `.xpi`.
4. Restart Zotero if prompted.

The plugin starts a local file queue under the Zotero profile directory by default. A client writes request JSON into `requests/`, and the plugin writes response JSON into `responses/`.

## Update

Release builds use GitHub Releases plus `updates.json`. Zotero can update the plugin when automatic updates are allowed for the add-on. `Default` follows Zotero's global add-on update setting; `On` always allows updates for this add-on; `Off` disables them for this add-on.

## Supported Operations

Read-only:

- `status`
- `capabilities`
- `list-collections`
- `search-items`
- `get-items`
- `get-item-children`
- `list-attachments`
- `metadata-audit`
- `find-duplicate-attachments`
- `inspect`

Dry-run first / write-capable:

- `update-item-fields`
- `link-file-to-item`
- `import-file-to-item`
- `copy-stored-to-cloud`
- `create-linked-copies`
- `cleanup-old-stored`
- `cleanup-duplicate-attachments`
- `trash-items-by-key`
- `erase-trash-by-key`

## CLI Examples

Check that the bridge is alive:

```powershell
python cli/zotero_bridge.py plugin-request --operation status --wait
```

Audit incomplete metadata without changing Zotero:

```powershell
python cli/zotero_bridge.py plugin-request --operation metadata-audit --args-json '{"itemTypes":["journalArticle","conferencePaper"]}' --wait
```

Find duplicate attachments. The duplicate rule first groups by the same parent item, content type, and file size, and only hashes those candidates:

```powershell
python cli/zotero_bridge.py plugin-request --operation find-duplicate-attachments --args-json '{"maxHashCandidateAttachments":200}' --wait
```

Preview duplicate cleanup. This only plans extra Zotero attachment records to move to Trash:

```powershell
python cli/zotero_bridge.py plugin-request --operation cleanup-duplicate-attachments --mode dry-run --wait
```

Apply only after reviewing the dry-run response:

```powershell
python cli/zotero_bridge.py plugin-request --operation cleanup-duplicate-attachments --mode apply --args-json '{"maxHashCandidateAttachments":200}' --wait
```

Update item fields by exact key:

```powershell
python cli/zotero_bridge.py plugin-request --operation update-item-fields --mode dry-run --args-json '{"updates":[{"key":"ABCD1234","fields":{"DOI":"10.1234/example"}}]}' --wait
```

For request and response details, see `docs/api.md`.

## MCP Server

The repository also includes a local MCP stdio adapter:

```powershell
python mcp/zotero_management_bridge_mcp.py
```

The MCP server does not access Zotero directly. It forwards tool calls to the installed Zotero plugin through the same queue protocol, then returns the plugin response as structured tool output.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "zotero-management-bridge": {
      "command": "python",
      "args": [
        "PATH_TO_REPO/mcp/zotero_management_bridge_mcp.py"
      ]
    }
  }
}
```

To allow write operations from MCP, start the server with `--allow-apply` or set `ZMB_MCP_ALLOW_APPLY=1`. Individual apply calls still require `confirmApply: true`. Dry-run calls are available by default.

See [docs/mcp.md](docs/mcp.md).

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

## API Documentation

See [docs/api.md](docs/api.md) for request/response examples and operation safety levels.

## Compatibility

Target: Zotero 7+ manifest format, tested locally against Zotero 9.

Zotero plugins have full access to Zotero and local files. Install only code you trust.

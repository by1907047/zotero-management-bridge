# [ANN] Zotero Management Bridge v0.4.0 - local management API for automation agents and scripts

Hi everyone,

I am releasing **Zotero Management Bridge v0.4.0**, a local Zotero plugin that exposes a controlled management API for automation agents, MCP clients, and scripts.

Repository:
https://github.com/by1907047/zotero-management-bridge

Release / XPI:
https://github.com/by1907047/zotero-management-bridge/releases/tag/v0.4.0

## What it does

Zotero Management Bridge runs inside Zotero and provides whitelisted operations for local library management:

- Query collections, items, item children, attachments, missing files, metadata gaps, and duplicate attachments.
- Create or update items from already verified metadata.
- Link or import local files to Zotero items.
- Run dry-run-first cleanup operations for duplicate attachments and old stored attachments.
- Produce JSON reports for automation workflows.
- Expose the same controlled operations through a CLI and an optional MCP server.

It is mainly intended for users who want local agents or scripts to manage Zotero safely without direct SQLite writes or arbitrary code execution inside Zotero.

## What it does not do

The plugin does **not**:

- scrape publisher websites,
- download papers or bypass institutional access,
- execute arbitrary JavaScript,
- write directly to the Zotero SQLite database,
- automatically delete external linked files.

Write-capable operations are designed to be explicit and auditable. Batch or risky actions should be run in `dry-run` mode first.

## Examples

Check status:

```powershell
python cli/zotero_bridge.py plugin-request --operation status --wait
```

Audit incomplete metadata:

```powershell
python cli/zotero_bridge.py plugin-request --operation metadata-audit --item-type journalArticle --wait
```

Find duplicate attachments:

```powershell
python cli/zotero_bridge.py plugin-request --operation find-duplicate-attachments --wait
```

## Compatibility

- Tested locally with Zotero 9.0.4 on Windows.
- Manifest target: Zotero `6.999` to `9.*`.
- This is the first public/community release, so feedback from other Zotero versions, operating systems, and storage setups is welcome.

## Security model

The plugin is intentionally narrow: it uses Zotero's own JavaScript API from inside Zotero, communicates through a local file queue, and exposes only named operations. The MCP adapter is a thin client layer and does not access Zotero directly.

Security notes:
https://github.com/by1907047/zotero-management-bridge/blob/main/docs/security.md

API docs:
https://github.com/by1907047/zotero-management-bridge/blob/main/docs/api.md

MCP docs:
https://github.com/by1907047/zotero-management-bridge/blob/main/docs/mcp.md

Feedback, issues, and suggestions are very welcome:
https://github.com/by1907047/zotero-management-bridge/issues

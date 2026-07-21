# Community Release Plan

This document tracks the current community release state and what remains before Zotero Management Bridge should be promoted to a long-term stable `v1.0.0` release.

Current target:

- Current version: `v0.4.1`
- Next community maintenance target: `v0.4.x`
- Stable target: `v1.0.0` after real-world testing by more than one library/workflow

## Release Principle

The plugin must stay a Zotero-local management layer. It should provide safe query, execution, verification, and reporting operations. It should not become a paper downloader, web scraper, arbitrary JavaScript executor, or direct SQLite editor.

Codex, MCP clients, or other external agents decide what to do. Zotero Management Bridge executes explicit whitelisted operations inside Zotero.

## Personal Workflow vs Community Defaults

The current project was validated against a OneDrive linked-attachment workflow. That should remain a supported example, not the universal assumption.

Community users may use:

- Zotero stored files only
- Local linked files
- OneDrive
- Dropbox
- Google Drive
- iCloud Drive
- Synology/NAS folders
- institution-managed cloud folders
- portable/external drives

The public API should therefore talk about a configurable attachment root, not OneDrive specifically.

## Storage Backend Design

Add a configurable attachment storage model before a broader public release.

Planned concepts:

- `attachmentRoot`: base folder for linked attachment files.
- `storageLayout`: path template below the root, defaulting to `storage/{attachmentKey}/{filename}`.
- `reportDir`: optional report output folder.
- `defaultLinkMode`: `linked` or `stored`.
- `externalFilePolicy`: default `never-delete`.
- `pathValidation`: verify target paths stay under configured roots for copy/move operations.

Important rules:

- OneDrive is only one possible `attachmentRoot`.
- External linked files are not deleted during Zotero cleanup.
- Zotero Trash cleanup and external orphan-file cleanup are separate workflows.
- The plugin should not infer a user's cloud provider from path names.
- Dry-run reports should show absolute resolved paths and whether files exist.

## CI Checklist

Add GitHub Actions before calling the project community-ready.

Minimum CI jobs:

- Validate JSON files:
  - `plugin/manifest.json`
  - `updates.json`
  - `schemas/*.json`
  - `examples/*.json`
- Check plugin JavaScript:
  - `node --check plugin/src/zotero-management-bridge.js`
- Check Python:
  - `python -m py_compile cli/zotero_bridge.py mcp/zotero_management_bridge_mcp.py`
- Run tests:
  - `node tests/test_plugin_helpers.js`
  - `python tests/test_cli_args_json.py`
  - `python tests/test_mcp_server.py`
- Package XPI:
  - ensure archive paths use `/`, not `\`
  - ensure `manifest.json`, `install.rdf`, `bootstrap.js`, `prefs.js`, and `src/zotero-management-bridge.js` are present
  - ensure `manifest.json` and `install.rdf` versions match
  - ensure both update metadata entries point to the hosted `updates.json`
- Privacy scan:
  - no personal paths
  - no university proxy URLs
  - no real OneDrive paths
  - no tokens or local queue paths

## Repository Cleanup

For public maintenance releases:

- Keep only current release artifacts attached to GitHub Releases.
- Do not commit `dist/`, debug logs, local reports, queue folders, or Zotero profile artifacts.
- Add or confirm `.gitignore` covers:
  - `dist/`
  - `*.log`
  - `__pycache__/`
  - `.pytest_cache/`
  - local report output
  - local queue output
- Ensure examples use placeholders such as `C:\Users\YOU\...` or `/Users/you/...`, not personal paths.

## Documentation Checklist

README should be readable by a non-developer Zotero user:

- What the plugin does
- What it does not do
- How to install the `.xpi`
- How to check that it is running
- How updates work
- Why an older beta may need one manual reinstall
- How dry-run/apply works
- What MCP is, and why it is optional
- Where reports are written
- How linked attachments differ from stored attachments
- How to configure attachment storage root

API documentation should list for every operation:

- Request example
- Response example
- Read-only vs dry-run-first vs destructive
- Whether it changes Zotero
- Whether it copies files
- Whether it can touch external linked files
- Required exact keys, if any

Security documentation should state clearly:

- No arbitrary JavaScript execution
- No direct SQLite writes
- No automatic deletion of external linked files
- Dangerous operations require exact keys or dry-run plans
- MCP `apply` requires explicit server-side and request-side opt-in

## Workflow Checklist

Recommended user-facing workflows:

- Install and status check
- Query library or collection
- Audit missing metadata
- Add or link a local file
- Convert stored attachments to configured linked-root attachments
- Detect duplicate attachments
- Dry-run duplicate cleanup
- Apply small duplicate cleanup
- Trash exact item keys
- Erase exact trash keys
- Produce a report without changing Zotero

Avoid presenting advanced migration as the first user story. Start with read-only inspection and status checks.

## Dogfood Findings From Nature Sensors Workflow

These issues came from using the literature workflow as a normal user to check a Nature Sensors collection, find a newly published article, try institutional access, download the first supplementary file, and attempt Zotero insertion.

### Priority 0: Core API Gaps

- Add `create-item` with dry-run support. The bridge can currently query existing Zotero items and link files to existing items, but cannot create a missing bibliographic record without falling back to Zotero Connector, manual UI, arbitrary Zotero JS, or direct database work.
- Add collection targeting to item creation. A user should be able to create an item directly into a named/keyed collection such as `Nature Sensors`.
- Add a client-side `add-article-by-doi` workflow. DOI/Crossref/publisher lookup should remain outside the plugin, but the plugin should accept the verified metadata and create/update the Zotero item.
- Add safe attachment linking for a newly created item in the same workflow: create item, then link full text and first supplementary file after each local file is validated.

### Priority 1: Storage Configuration

- Replace personal OneDrive assumptions with a configurable attachment root.
- Support common storage modes:
  - Zotero stored files only
  - local linked folder
  - OneDrive
  - Dropbox
  - Google Drive
  - iCloud Drive
  - NAS or external drive
- Keep OneDrive only as an example, not a default assumption for community users.
- Include `status` fields that clearly distinguish:
  - Zotero data directory
  - configured linked attachment root
  - report directory
  - queue directory
- If no linked attachment root is configured, report that explicitly instead of inventing a default path that may not match the user's workflow.

### Priority 1: Connector Boundary

- Document clearly that Zotero Connector and Zotero Management Bridge are separate channels:
  - Connector/browser button is useful for manual saves and translator-based web capture.
  - Bridge is useful for controlled library management, queries, linking, cleanup, and reports.
- Do not diagnose Connector health with PowerShell `Invoke-WebRequest`; it can send headers that make Zotero close the connection.
- Add a Connector health check helper that uses a known-compatible request style, such as `curl.exe` or Python urllib without browser-like headers.
- In docs, tell users the manual save path is the browser Zotero Connector button or `Ctrl+Shift+S`, not the Bridge.

### Priority 1: CLI Usability

- Make `--args-json` tolerate UTF-8 BOM, because Windows PowerShell can create BOM-marked JSON files.
- Improve JSON parse errors by showing whether the input came from inline text or `@file`.
- Add PowerShell-friendly shortcuts for common operations:
  - `search-items --query "..."`
  - `search-items --doi "..."`
  - `metadata-audit --item-type journalArticle`
  - `list-attachments --keys ABCD1234`
- Keep `--args-json` for full API coverage, but avoid making ordinary users hand-escape JSON in shells.
- Make CLI summaries optionally print compact tables for read-only operations, so users do not always need to open JSON report files.

### Priority 1: Text Encoding

- Fix garbled Chinese collection names in CLI/report display paths.
- Ensure report files are UTF-8 without BOM unless a downstream spreadsheet workflow explicitly needs UTF-8 with BOM.
- Set or document `PYTHONIOENCODING=utf-8` for Windows terminal output when printing titles with special Unicode punctuation.

### Priority 2: Access And Publisher Workflow

- Keep publisher access outside the plugin. The plugin should not download papers or bypass institutional access.
- In the literature workflow, treat `Change institution`, `Buy or subscribe`, MFA, and human verification screens as stop points.
- Add a clear result category for failed full-text retrieval:
  - no institutional access
  - proxy login required
  - human verification required
  - PDF URL returned HTML
  - publisher has no PDF link exposed
- Continue the Nature Sensors rule: first Supplementary Information file only by default.

### Priority 2: MCP Default Path

- Make MCP the preferred Codex path for daily use, because it avoids shell quoting problems.
- Keep CLI for diagnostics, tests, and scripted workflows.
- Provide a one-page MCP setup check:
  - plugin status
  - MCP status
  - read-only query
  - dry-run write
  - apply disabled by default

### Priority 2: Update Experience

- Keep both `manifest.json` and `install.rdf` update metadata in sync.
- Add a release test that installs the previous beta and verifies that Zotero can discover the next beta.
- Document that users stranded on older beta builds may need one manual reinstall before automatic updates become reliable.

## Duplicate Attachment Roadmap

Current duplicate classes:

- `exact`: same parent, content type, size, and hash.
- `probable`: same parent, same attachment kind, near-size, and supporting title/token evidence.
- `possible`: review-only groups for likely duplicate primary files when names and sizes differ more.

Next improvements:

- Expose tuning parameters in docs:
  - near-size byte threshold
  - near-size ratio
  - generic-title list
  - attachment-kind classification
- Improve review reports for possible duplicates:
  - file size
  - path
  - title
  - modified time if available
  - open/check instructions
- Keep `possible` groups review-only unless future versions add stronger content fingerprinting.

## MCP Checklist

MCP should remain a thin client-facing adapter:

- It forwards requests to the plugin queue.
- It does not read or write Zotero directly.
- It defaults to read-only/dry-run behavior.
- Apply requires:
  - server started with apply enabled
  - request includes explicit apply confirmation

Docs should include:

- Codex config example
- Cursor/Claude Desktop style generic config example if applicable
- Windows path quoting notes
- How to disable apply
- How to diagnose missing plugin queue/status

## Release Process

For each release:

1. Update `plugin/manifest.json`.
2. Update `plugin/install.rdf`.
3. Build XPI.
4. Compute SHA-256.
5. Update `updates.json`.
6. Run local checks and tests.
7. Commit changes.
8. Push to GitHub.
9. Create GitHub Release and upload XPI.
10. Verify release asset returns HTTP 200.
11. Verify `updates.json` on GitHub points to the new version.
12. Install/update locally in Zotero.
13. Run smoke tests against a real Zotero library.

## Real-Library Smoke Test

Before announcing a community maintenance release:

- `status`
- `capabilities`
- `list-collections`
- `search-items`
- `get-items`
- `get-item-children`
- `list-attachments`
- `metadata-audit`
- `find-duplicate-attachments`
- `cleanup-duplicate-attachments` in `dry-run`
- one tiny `cleanup-duplicate-attachments` apply case, if a safe duplicate exists
- `update-item-fields` dry-run and one-item apply
- `link-file-to-item` dry-run with a known local file

All apply tests should use tiny, known fixtures or a disposable Zotero test item.

## Open Questions

- Should the plugin expose a small Zotero preference pane for attachment root and report directory, or should configuration remain client-side JSON for now?
- Should linked-root migration be a core public feature in `v0.4`, or kept as an advanced feature until `v1.0`?
- Should `stored` attachment workflows receive first-class examples, or should examples focus on read-only inspection first?
- Should the MCP server ship as a separate Python package later, or remain in-repo as a local adapter?

## Proposed Milestones

### `v0.4.0`

- Community release with configurable attachment-root messaging, CI baseline, README/API/MCP/security documentation, create-item support, MCP create support, duplicate attachment audits, and release packaging.

### `v0.4.1`

- Add exact collection-path resolution and dry-run-first assignment of existing items to collections.
- Reject duplicate DOI creation by default and preserve existing collection memberships.
- Add MCP schemas, documentation, and regression tests for the safer literature-ingestion workflow.

### `v0.5.0-beta.0`

- Better possible-duplicate review reports.
- Stronger metadata audit examples.
- More complete MCP docs.
- Issue templates and contribution guide.

### `v1.0.0`

- Stable operation names.
- Stable config format.
- Verified install/update path.
- Tested on at least two independent Zotero libraries and two storage setups.
- Clear project boundary and security model.

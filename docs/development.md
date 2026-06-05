# Development Notes

## Zotero Version Target

The plugin uses the Zotero 7+ WebExtension-style `manifest.json` and `bootstrap.js` lifecycle.

The alpha manifest currently sets:

- `strict_min_version`: `6.999`
- `strict_max_version`: `9.*`

Raise the max version only after testing with that Zotero version.

## Local Development

Use a separate Zotero profile and data directory for plugin development when possible.

Static checks:

```powershell
node --check plugin/src/zotero-management-bridge.js
python -m py_compile cli/zotero_bridge.py
```

Unit tests:

```powershell
node tests/test_plugin_helpers.js
python tests/test_cli_args_json.py
python tests/test_mcp_server.py
```

Package the plugin:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

Install the generated `.xpi` manually in Zotero through Tools -> Plugins.

## Queue Protocol

The CLI or another local client writes JSON request files into:

```text
<queueRoot>/requests
```

The plugin writes JSON responses into:

```text
<queueRoot>/responses
```

Processed and failed requests are moved into:

```text
<queueRoot>/processed
<queueRoot>/failed
```

## Release Checklist

Before publishing a release:

1. Update `plugin/manifest.json`, `plugin/install.rdf`, and `updates.json`.
2. Run JavaScript and Python syntax checks.
3. Run unit tests.
4. Parse-check JSON files: manifests, schemas, and `updates.json`.
5. Package the `.xpi`.
6. Inspect the package paths and confirm they use forward slashes, for example `src/zotero-management-bridge.js`.
7. Calculate the XPI SHA-256 and copy it into `updates.json`.
8. Run a privacy string scan to catch personal paths or institutional access strings.
9. Install or update the packaged XPI in local Zotero.
10. Run smoke tests through the plugin queue:
    - `status`
    - `inspect`
    - `metadata-audit`
    - `find-duplicate-attachments`
    - `cleanup-duplicate-attachments` in `dry-run`
11. Run the MCP smoke test from `docs/mcp.md` if the MCP adapter changed.
12. For destructive behavior, test only a tiny known fixture and confirm records are moved to Zotero Trash rather than permanently deleted.
13. Upload the `.xpi` to GitHub Releases and ensure `updates.json` points to the matching version and hash.

## Version Roadmap

- `v0.2.0-alpha.6`: native duplicate attachment audit and cleanup.
- `v0.2.0-alpha.7`: metadata audit and query API.
- `v0.3.0-beta.0`: consolidated community trial with docs, CLI, tests, packaging, and release flow.

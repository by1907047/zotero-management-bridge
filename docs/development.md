# Development Notes

## Zotero Version Target

The plugin uses the Zotero 7+ WebExtension-style `manifest.json` and `bootstrap.js` lifecycle.

The alpha manifest currently sets:

- `strict_min_version`: `6.999`
- `strict_max_version`: `9.*`

Raise the max version only after testing with that Zotero version.

## Local Development

Use a separate Zotero profile and data directory for plugin development when possible.

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

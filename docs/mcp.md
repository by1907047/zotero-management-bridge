# MCP Server

`mcp/zotero_management_bridge_mcp.py` is a stdio MCP adapter for Zotero Management Bridge.

It does not read or write Zotero directly. It forwards MCP tool calls to the installed Zotero plugin through the local queue:

```text
MCP client -> MCP stdio server -> bridge queue -> Zotero plugin -> Zotero API
```

## Start

```powershell
python mcp/zotero_management_bridge_mcp.py
```

Optional flags:

```powershell
python mcp/zotero_management_bridge_mcp.py --queue-root "PATH/TO/queue" --timeout 60
python mcp/zotero_management_bridge_mcp.py --allow-apply
```

Environment variables:

- `ZMB_QUEUE_ROOT`: queue directory override.
- `ZMB_MCP_TIMEOUT`: default response timeout in seconds.
- `ZMB_MCP_ALLOW_APPLY=1`: allow apply-mode tool calls.

If `ZMB_QUEUE_ROOT` is not set, the server tries to discover the queue in the local Zotero profile. If no Zotero profile queue exists yet, start Zotero once after installing the plugin.

## Client Configuration

Generic stdio MCP client configuration:

```json
{
  "mcpServers": {
    "zotero-management-bridge": {
      "command": "python",
      "args": [
        "PATH_TO_REPO/mcp/zotero_management_bridge_mcp.py"
      ],
      "env": {
        "ZMB_MCP_TIMEOUT": "60"
      }
    }
  }
}
```

Use an absolute path in real client configuration.

## Tools

The adapter exposes these tools:

- `zmb_request`: generic bridge operation wrapper.
- `zmb_status`
- `zmb_capabilities`
- `zmb_list_collections`
- `zmb_search_items`
- `zmb_get_items`
- `zmb_get_item_children`
- `zmb_list_attachments`
- `zmb_metadata_audit`
- `zmb_find_duplicate_attachments`
- `zmb_cleanup_duplicate_attachments`
- `zmb_update_item_fields`
- `zmb_link_file_to_item`
- `zmb_trash_items_by_key`
- `zmb_erase_trash_by_key`

The generic wrapper accepts:

```json
{
  "operation": "metadata-audit",
  "mode": "dry-run",
  "args": {},
  "timeout": 60
}
```

## Apply Safety

Dry-run calls work by default. Apply calls require two things:

1. Start the MCP server with `--allow-apply` or `ZMB_MCP_ALLOW_APPLY=1`.
2. Pass `confirmApply: true` in the individual tool call.

This keeps accidental writes from AI clients from bypassing the bridge's dry-run-first model.

External linked files are not deleted by cleanup or trash operations.

## Smoke Test

With Zotero running and the plugin installed:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"zmb_status","arguments":{}}}
'@ | python mcp/zotero_management_bridge_mcp.py
```

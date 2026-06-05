#!/usr/bin/env python3
"""MCP stdio adapter for Zotero Management Bridge.

The MCP server does not talk to Zotero directly. It writes requests to the
bridge plugin queue and returns the plugin response as MCP tool output.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import traceback
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import zotero_bridge


SERVER_NAME = "zotero-management-bridge"
SERVER_VERSION = "0.2.0"
PROTOCOL_VERSION = "2025-06-18"


class ToolError(Exception):
    pass


def object_schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
        "additionalProperties": False,
    }


COMMON_TIMEOUT = {
    "type": "number",
    "minimum": 1,
    "default": 60,
    "description": "Seconds to wait for the Zotero plugin response.",
}

COMMON_MODE = {
    "type": "string",
    "enum": ["dry-run", "apply"],
    "default": "dry-run",
    "description": "Use dry-run first. apply requires confirmApply=true.",
}

COMMON_CONFIRM = {
    "type": "boolean",
    "default": False,
    "description": "Required when mode is apply.",
}


TOOLS: list[dict[str, Any]] = [
    {
        "name": "zmb_request",
        "description": "Run any whitelisted Zotero Management Bridge operation through the plugin queue.",
        "inputSchema": object_schema({
            "operation": {"type": "string", "description": "Bridge operation name, for example metadata-audit."},
            "mode": COMMON_MODE,
            "args": {"type": "object", "additionalProperties": True, "default": {}},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }, ["operation"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
    {
        "name": "zmb_status",
        "description": "Check Zotero Management Bridge status and Zotero version.",
        "inputSchema": object_schema({"timeout": COMMON_TIMEOUT}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_capabilities",
        "description": "List bridge operations and safety capabilities.",
        "inputSchema": object_schema({"timeout": COMMON_TIMEOUT}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_list_collections",
        "description": "List Zotero collections with paths.",
        "inputSchema": object_schema({"timeout": COMMON_TIMEOUT}),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_search_items",
        "description": "Search Zotero items by query, DOI, item type, and year.",
        "inputSchema": object_schema({
            "query": {"type": "string"},
            "doi": {"type": "string"},
            "itemType": {"type": "string"},
            "year": {"type": "string"},
            "limit": {"type": "integer", "minimum": 1, "default": 100},
            "timeout": COMMON_TIMEOUT,
        }),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_get_items",
        "description": "Get full item metadata for exact Zotero item keys.",
        "inputSchema": object_schema({
            "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "timeout": COMMON_TIMEOUT,
        }, ["keys"]),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_get_item_children",
        "description": "Get child attachments and notes for exact Zotero item keys.",
        "inputSchema": object_schema({
            "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "timeout": COMMON_TIMEOUT,
        }, ["keys"]),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_list_attachments",
        "description": "List Zotero attachments with optional category and content type filters.",
        "inputSchema": object_schema({
            "category": {"type": "string", "enum": ["linked-file", "stored-file", "html-snapshot", "linked-url", "other"]},
            "contentType": {"type": "string"},
            "timeout": COMMON_TIMEOUT,
        }),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_metadata_audit",
        "description": "Find Zotero items with incomplete title, DOI, date, publication, or creator metadata.",
        "inputSchema": object_schema({
            "itemTypes": {"type": "array", "items": {"type": "string"}},
            "doiItemTypes": {"type": "array", "items": {"type": "string"}},
            "dateItemTypes": {"type": "array", "items": {"type": "string"}},
            "timeout": COMMON_TIMEOUT,
        }),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_find_duplicate_attachments",
        "description": "Find exact and probable duplicate attachment records using same parent, content type, exact hash, and same-kind near-size evidence.",
        "inputSchema": object_schema({
            "includeStoredFiles": {"type": "boolean", "default": False},
            "includeSnapshots": {"type": "boolean", "default": True},
            "enableNearDuplicateAttachments": {"type": "boolean", "default": True},
            "enablePossibleDuplicateAttachments": {"type": "boolean", "default": True},
            "maxHashCandidateAttachments": {"type": "integer", "minimum": 1, "default": 200},
            "nearDuplicateMaxSizeDeltaBytes": {"type": "integer", "minimum": 0, "default": 8192},
            "nearDuplicateMaxSizeDeltaRatio": {"type": "number", "minimum": 0, "default": 0.01},
            "timeout": COMMON_TIMEOUT,
        }),
        "annotations": {"readOnlyHint": True, "destructiveHint": False},
    },
    {
        "name": "zmb_cleanup_duplicate_attachments",
        "description": "Dry-run or apply duplicate attachment cleanup. Apply moves extra Zotero attachment records to Trash only.",
        "inputSchema": object_schema({
            "mode": COMMON_MODE,
            "includeStoredFiles": {"type": "boolean", "default": False},
            "includeSnapshots": {"type": "boolean", "default": True},
            "enableNearDuplicateAttachments": {"type": "boolean", "default": True},
            "enablePossibleDuplicateAttachments": {"type": "boolean", "default": True},
            "maxHashCandidateAttachments": {"type": "integer", "minimum": 1, "default": 200},
            "nearDuplicateMaxSizeDeltaBytes": {"type": "integer", "minimum": 0, "default": 8192},
            "nearDuplicateMaxSizeDeltaRatio": {"type": "number", "minimum": 0, "default": 0.01},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
    {
        "name": "zmb_update_item_fields",
        "description": "Dry-run or apply exact-key Zotero item field updates.",
        "inputSchema": object_schema({
            "mode": COMMON_MODE,
            "updates": {"type": "array", "items": {"type": "object", "additionalProperties": True}, "minItems": 1},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }, ["updates"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "zmb_create_item",
        "description": "Dry-run or apply Zotero item creation from already-verified metadata. Does not fetch DOI/web metadata.",
        "inputSchema": object_schema({
            "mode": COMMON_MODE,
            "itemType": {"type": "string", "default": "journalArticle"},
            "title": {"type": "string"},
            "fields": {"type": "object", "additionalProperties": True},
            "creators": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            "tags": {"type": "array", "items": {"type": ["string", "object"]}},
            "collectionKey": {"type": "string"},
            "collectionName": {"type": "string"},
            "requireCollections": {"type": "boolean", "default": True},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }, ["title"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "zmb_link_file_to_item",
        "description": "Dry-run or apply linked-file attachment creation for an exact parent item key.",
        "inputSchema": object_schema({
            "mode": COMMON_MODE,
            "parentKey": {"type": "string"},
            "filePath": {"type": "string"},
            "relativePath": {"type": "string"},
            "title": {"type": "string"},
            "contentType": {"type": "string"},
            "skipExisting": {"type": "boolean"},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }, ["parentKey", "filePath"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": False},
    },
    {
        "name": "zmb_trash_items_by_key",
        "description": "Dry-run or apply moving exact Zotero item keys to Trash. Does not delete linked files.",
        "inputSchema": object_schema({
            "mode": COMMON_MODE,
            "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }, ["keys"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
    {
        "name": "zmb_erase_trash_by_key",
        "description": "Dry-run or apply permanent erase for exact Zotero keys that are already in Trash.",
        "inputSchema": object_schema({
            "mode": COMMON_MODE,
            "keys": {"type": "array", "items": {"type": "string"}, "minItems": 1},
            "timeout": COMMON_TIMEOUT,
            "confirmApply": COMMON_CONFIRM,
        }, ["keys"]),
        "annotations": {"readOnlyHint": False, "destructiveHint": True},
    },
]


def clean_args(arguments: dict[str, Any], drop: set[str]) -> dict[str, Any]:
    return {key: value for key, value in arguments.items() if key not in drop and value is not None}


def require_apply_confirmation(mode: str, confirm_apply: bool) -> None:
    if mode == "apply" and not confirm_apply:
        raise ToolError("mode=apply requires confirmApply=true")


class ZoteroBridgeMCPServer:
    def __init__(self, queue_root: Path, default_timeout: float, allow_apply: bool):
        self.queue_root = queue_root
        self.default_timeout = default_timeout
        self.allow_apply = allow_apply

    def run_operation(self, operation: str, mode: str = "dry-run", args: dict[str, Any] | None = None, timeout: float | None = None, confirm_apply: bool = False) -> dict[str, Any]:
        if mode not in {"dry-run", "apply"}:
            raise ToolError("mode must be dry-run or apply")
        require_apply_confirmation(mode, confirm_apply)
        if mode == "apply" and not self.allow_apply:
            raise ToolError("This MCP server was started without --allow-apply or ZMB_MCP_ALLOW_APPLY=1")
        return zotero_bridge.submit_plugin_request(
            operation=operation,
            mode=mode,
            request_args=args or {},
            queue_root=self.queue_root,
            timeout=timeout or self.default_timeout,
        )

    def call_tool(self, name: str, arguments: dict[str, Any] | None) -> dict[str, Any]:
        arguments = arguments or {}
        timeout = float(arguments.get("timeout") or self.default_timeout)
        confirm_apply = bool(arguments.get("confirmApply"))

        if name == "zmb_request":
            return self.run_operation(
                operation=str(arguments.get("operation") or ""),
                mode=str(arguments.get("mode") or "dry-run"),
                args=dict(arguments.get("args") or {}),
                timeout=timeout,
                confirm_apply=confirm_apply,
            )

        mapping = {
            "zmb_status": ("status", "dry-run", set()),
            "zmb_capabilities": ("capabilities", "dry-run", set()),
            "zmb_list_collections": ("list-collections", "dry-run", set()),
            "zmb_search_items": ("search-items", "dry-run", {"timeout"}),
            "zmb_get_items": ("get-items", "dry-run", {"timeout"}),
            "zmb_get_item_children": ("get-item-children", "dry-run", {"timeout"}),
            "zmb_list_attachments": ("list-attachments", "dry-run", {"timeout"}),
            "zmb_metadata_audit": ("metadata-audit", "dry-run", {"timeout"}),
            "zmb_find_duplicate_attachments": ("find-duplicate-attachments", "dry-run", {"timeout"}),
            "zmb_cleanup_duplicate_attachments": ("cleanup-duplicate-attachments", str(arguments.get("mode") or "dry-run"), {"timeout", "mode", "confirmApply"}),
            "zmb_create_item": ("create-item", str(arguments.get("mode") or "dry-run"), {"timeout", "mode", "confirmApply"}),
            "zmb_update_item_fields": ("update-item-fields", str(arguments.get("mode") or "dry-run"), {"timeout", "mode", "confirmApply"}),
            "zmb_link_file_to_item": ("link-file-to-item", str(arguments.get("mode") or "dry-run"), {"timeout", "mode", "confirmApply"}),
            "zmb_trash_items_by_key": ("trash-items-by-key", str(arguments.get("mode") or "dry-run"), {"timeout", "mode", "confirmApply"}),
            "zmb_erase_trash_by_key": ("erase-trash-by-key", str(arguments.get("mode") or "dry-run"), {"timeout", "mode", "confirmApply"}),
        }
        if name not in mapping:
            raise ToolError(f"Unknown tool: {name}")
        operation, mode, drop = mapping[name]
        return self.run_operation(
            operation=operation,
            mode=mode,
            args=clean_args(arguments, drop),
            timeout=timeout,
            confirm_apply=confirm_apply,
        )


def make_tool_result(response: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [
            {
                "type": "text",
                "text": json.dumps(response, ensure_ascii=False, indent=2),
            }
        ],
        "structuredContent": response,
        "isError": response.get("ok") is False,
    }


def jsonrpc_result(message_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message_id, "result": result}


def jsonrpc_error(message_id: Any, code: int, message: str, data: Any | None = None) -> dict[str, Any]:
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": message_id, "error": error}


def handle_message(server: ZoteroBridgeMCPServer, message: dict[str, Any]) -> dict[str, Any] | None:
    method = message.get("method")
    message_id = message.get("id")
    params = message.get("params") or {}

    if message_id is None:
        return None

    try:
        if method == "initialize":
            requested_protocol = params.get("protocolVersion") or PROTOCOL_VERSION
            return jsonrpc_result(message_id, {
                "protocolVersion": requested_protocol,
                "capabilities": {
                    "tools": {"listChanged": False},
                    "resources": {},
                    "prompts": {},
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION,
                },
                "instructions": "Use dry-run first. Apply calls require confirmApply=true and server-side apply enablement.",
            })
        if method == "ping":
            return jsonrpc_result(message_id, {})
        if method == "tools/list":
            return jsonrpc_result(message_id, {"tools": TOOLS})
        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments") or {}
            response = server.call_tool(str(name), arguments)
            return jsonrpc_result(message_id, make_tool_result(response))
        if method == "resources/list":
            return jsonrpc_result(message_id, {"resources": []})
        if method == "prompts/list":
            return jsonrpc_result(message_id, {"prompts": []})
        return jsonrpc_error(message_id, -32601, f"Method not found: {method}")
    except ToolError as exc:
        return jsonrpc_error(message_id, -32602, str(exc))
    except Exception as exc:
        return jsonrpc_error(message_id, -32000, str(exc), traceback.format_exc())


def write_message(message: dict[str, Any]) -> None:
    line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
    if hasattr(sys.stdout, "buffer"):
        sys.stdout.buffer.write(line.encode("utf-8"))
        sys.stdout.buffer.flush()
        return
    sys.stdout.write(line)
    sys.stdout.flush()


def serve(server: ZoteroBridgeMCPServer) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            response = handle_message(server, message)
        except Exception as exc:
            response = jsonrpc_error(None, -32700, str(exc), traceback.format_exc())
        if response is not None:
            write_message(response)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Zotero Management Bridge MCP stdio server")
    parser.add_argument("--queue-root", type=Path, default=zotero_bridge.DEFAULT_PLUGIN_QUEUE)
    parser.add_argument("--timeout", type=float, default=float(os.environ.get("ZMB_MCP_TIMEOUT", "60")))
    parser.add_argument("--allow-apply", action="store_true", default=os.environ.get("ZMB_MCP_ALLOW_APPLY") == "1")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    server = ZoteroBridgeMCPServer(
        queue_root=args.queue_root,
        default_timeout=args.timeout,
        allow_apply=args.allow_apply,
    )
    serve(server)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

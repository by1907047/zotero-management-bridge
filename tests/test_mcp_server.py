import unittest
from pathlib import Path
import sys
import io

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "mcp"))

import zotero_management_bridge_mcp as mcp


class FakeServer(mcp.ZoteroBridgeMCPServer):
    def __init__(self):
        super().__init__(queue_root=Path("."), default_timeout=5, allow_apply=False)
        self.calls = []

    def run_operation(self, operation, mode="dry-run", args=None, timeout=None, confirm_apply=False):
        self.calls.append({
            "operation": operation,
            "mode": mode,
            "args": args or {},
            "timeout": timeout,
            "confirmApply": confirm_apply,
        })
        return {"ok": True, "operation": operation, "mode": mode, "args": args or {}}


class MCPServerTests(unittest.TestCase):
    def test_initialize(self):
        server = FakeServer()
        response = mcp.handle_message(server, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        })
        self.assertEqual(response["result"]["serverInfo"]["name"], "zotero-management-bridge")
        self.assertIn("tools", response["result"]["capabilities"])

    def test_tools_list_contains_generic_request(self):
        server = FakeServer()
        response = mcp.handle_message(server, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [tool["name"] for tool in response["result"]["tools"]]
        self.assertIn("zmb_request", names)
        self.assertIn("zmb_metadata_audit", names)

    def test_specific_tool_maps_to_bridge_operation(self):
        server = FakeServer()
        response = mcp.handle_message(server, {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "zmb_search_items",
                "arguments": {"query": "flow", "limit": 5},
            },
        })
        self.assertTrue(response["result"]["structuredContent"]["ok"])
        self.assertEqual(server.calls[0]["operation"], "search-items")
        self.assertEqual(server.calls[0]["args"]["query"], "flow")
        self.assertEqual(server.calls[0]["args"]["limit"], 5)

    def test_apply_requires_confirmation_before_queue_call(self):
        server = mcp.ZoteroBridgeMCPServer(queue_root=Path("."), default_timeout=5, allow_apply=True)
        response = mcp.handle_message(server, {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "zmb_request",
                "arguments": {"operation": "trash-items-by-key", "mode": "apply", "args": {"keys": ["ABCD1234"]}},
            },
        })
        self.assertEqual(response["error"]["code"], -32602)
        self.assertIn("confirmApply", response["error"]["message"])

    def test_apply_requires_server_enablement(self):
        server = mcp.ZoteroBridgeMCPServer(queue_root=Path("."), default_timeout=5, allow_apply=False)
        response = mcp.handle_message(server, {
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "zmb_request",
                "arguments": {
                    "operation": "trash-items-by-key",
                    "mode": "apply",
                    "args": {"keys": ["ABCD1234"]},
                    "confirmApply": True,
                },
            },
        })
        self.assertEqual(response["error"]["code"], -32602)
        self.assertIn("--allow-apply", response["error"]["message"])

    def test_write_message_uses_utf8_buffer(self):
        original_stdout = sys.stdout
        buffer = io.BytesIO()

        class FakeStdout:
            def __init__(self, inner):
                self.buffer = inner

        try:
            sys.stdout = FakeStdout(buffer)
            mcp.write_message({"jsonrpc": "2.0", "id": 6, "result": {"text": "中文"}})
        finally:
            sys.stdout = original_stdout

        self.assertIn("中文".encode("utf-8"), buffer.getvalue())


if __name__ == "__main__":
    unittest.main()

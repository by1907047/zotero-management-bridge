import json
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "cli"))

import zotero_bridge


class ArgsJsonTests(unittest.TestCase):
    def test_load_inline_args_json(self):
        data = zotero_bridge.load_args_json('{"limit": 5, "query": "flow"}')
        self.assertEqual(data, {"limit": 5, "query": "flow"})

    def test_load_shell_escaped_args_json(self):
        data = zotero_bridge.load_args_json('{\\"limit\\": 5, \\"query\\": \\"flow\\"}')
        self.assertEqual(data, {"limit": 5, "query": "flow"})

    def test_load_file_args_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "args.json"
            path.write_text('{"keys": ["ABC12345"]}', encoding="utf-8")
            data = zotero_bridge.load_args_json(f"@{path}")
        self.assertEqual(data, {"keys": ["ABC12345"]})

    def test_plugin_request_merges_args_json_and_shortcuts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = Namespace(
                id="req1",
                operation="metadata-audit",
                mode="dry-run",
                queue_root=root / "queue",
                report_dir=root / "reports",
                cloud_root=root / "cloud",
                args_json='{"limit": 10}',
                keys="AAA11111, BBB22222",
                move=False,
                parent_key=None,
                file_path=None,
                relative_path=None,
                title=None,
                content_type=None,
                no_skip_existing=False,
                skip_date_modified_update=False,
                wait=False,
                timeout=1,
            )
            exit_code = zotero_bridge.command_plugin_request(args)
            self.assertEqual(exit_code, 0)
            request = json.loads((root / "queue" / "requests" / "req1.json").read_text(encoding="utf-8"))
        self.assertEqual(request["operation"], "metadata-audit")
        self.assertEqual(request["mode"], "dry-run")
        self.assertEqual(request["args"]["limit"], 10)
        self.assertEqual(request["args"]["keys"], ["AAA11111", "BBB22222"])
        self.assertEqual(request["args"]["cloudBase"], str(root / "cloud"))


if __name__ == "__main__":
    unittest.main()

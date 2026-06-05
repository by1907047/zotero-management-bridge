#!/usr/bin/env python3
"""Command-line helper for Zotero Management Bridge.

This tool writes request JSON files for the Zotero plugin queue, waits for
responses, and can perform legacy read-only inspection/copy workflows.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid


CONNECTOR = "http://127.0.0.1:23119"
DEFAULT_ZOTERO_DATA = Path.home() / "Zotero"
DEFAULT_CLOUD_ROOT = Path(os.environ.get("ZMB_CLOUD_ROOT", Path.home() / "ZoteroLinkedAttachments"))
DEFAULT_REPORT_DIR = Path(os.environ.get("ZMB_REPORT_DIR", Path.cwd() / "zotero-management-bridge-reports"))
DEFAULT_PLUGIN_QUEUE = Path(os.environ.get("ZMB_QUEUE_ROOT", Path.home() / ".zotero-management-bridge" / "queue"))
STORED_LINK_MODES = {"imported_file", "imported_url"}


def timestamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d_%H%M%S")


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, data: dict) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_csv(path: Path, rows: list[dict]) -> None:
    ensure_dir(path.parent)
    fieldnames: list[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def http_get_json(path: str):
    url = CONNECTOR + path
    req = urllib.request.Request(url, headers={"User-Agent": "Zotero-Management-Bridge"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text), resp.headers


def http_get_text(path: str) -> str:
    req = urllib.request.Request(CONNECTOR + path, headers={"User-Agent": "Zotero-Management-Bridge"})
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.read().decode("utf-8", errors="replace")


def ping() -> tuple[bool, str]:
    try:
        return True, http_get_text("/connector/ping")
    except Exception as exc:
        return False, str(exc)


def fetch_all_attachments() -> list[dict]:
    items: list[dict] = []
    start = 0
    limit = 100
    while True:
        chunk, headers = http_get_json(f"/api/users/0/items?itemType=attachment&limit={limit}&start={start}")
        if not isinstance(chunk, list):
            raise RuntimeError("Unexpected Zotero response while listing attachments")
        items.extend(chunk)
        total = int(headers.get("Total-Results", len(items)))
        if len(items) >= total or not chunk:
            break
        start += limit
    return items


def attachment_data(item: dict) -> dict:
    data = item.get("data") or {}
    return {
        "key": item.get("key") or data.get("key") or "",
        "parentItem": data.get("parentItem") or "",
        "title": data.get("title") or "",
        "linkMode": data.get("linkMode") or "",
        "contentType": data.get("contentType") or "",
        "path": data.get("path") or "",
        "filename": data.get("filename") or "",
        "url": data.get("url") or "",
    }


def storage_filename(path_value: str, fallback: str) -> str:
    if path_value.startswith("storage:"):
        return path_value[len("storage:") :]
    return fallback or Path(path_value).name


def is_html_snapshot(row: dict) -> bool:
    return (row.get("contentType") or "").lower() == "text/html"


def is_stored_file(row: dict) -> bool:
    return row.get("linkMode") in STORED_LINK_MODES and not is_html_snapshot(row)


def is_linked_file(row: dict) -> bool:
    return row.get("linkMode") == "linked_file"


def source_path(zotero_data: Path, row: dict) -> Path:
    name = storage_filename(row.get("path", ""), row.get("filename", ""))
    return zotero_data / "storage" / row["key"] / name


def cloud_path(cloud_root: Path, row: dict) -> Path:
    name = storage_filename(row.get("path", ""), row.get("filename", ""))
    return cloud_root / "storage" / row["key"] / name


def relative_cloud_path(row: dict) -> str:
    name = storage_filename(row.get("path", ""), row.get("filename", ""))
    return f"storage/{row['key']}/{name}"


def command_status(args: argparse.Namespace) -> int:
    ok, message = ping()
    report = {
        "ok": ok,
        "connector": CONNECTOR,
        "message": message,
        "zoteroDataDir": str(args.zotero_data),
        "cloudRoot": str(args.cloud_root),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 2


def command_inspect(args: argparse.Namespace) -> int:
    ok, message = ping()
    if not ok:
        print(f"Zotero connector unavailable: {message}", file=sys.stderr)
        return 2
    rows = [attachment_data(item) for item in fetch_all_attachments()]
    details = []
    summary = {
        "checkedAttachments": len(rows),
        "storedFiles": 0,
        "linkedFiles": 0,
        "htmlSnapshots": 0,
        "storedSourceMissing": 0,
        "storedCloudPresent": 0,
        "storedCloudMissing": 0,
    }
    for row in rows:
        detail = dict(row)
        if is_html_snapshot(row):
            summary["htmlSnapshots"] += 1
            detail["category"] = "html-snapshot"
        elif is_stored_file(row):
            summary["storedFiles"] += 1
            src = source_path(args.zotero_data, row)
            dst = cloud_path(args.cloud_root, row)
            detail["category"] = "stored-file"
            detail["sourcePath"] = str(src)
            detail["cloudPath"] = str(dst)
            detail["sourceExists"] = src.exists()
            detail["cloudExists"] = dst.exists()
            if not src.exists():
                summary["storedSourceMissing"] += 1
            if dst.exists():
                summary["storedCloudPresent"] += 1
            else:
                summary["storedCloudMissing"] += 1
        elif is_linked_file(row):
            summary["linkedFiles"] += 1
            detail["category"] = "linked-file"
        else:
            detail["category"] = "other"
        details.append(detail)

    report = {
        "dryRun": True,
        "operation": "inspect",
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "zoteroDataDir": str(args.zotero_data),
        "cloudRoot": str(args.cloud_root),
        "summary": summary,
        "details": details,
    }
    path = ensure_dir(args.report_dir) / f"zotero_management_bridge_inspect_{timestamp()}.json"
    write_json(path, report)
    write_csv(path.with_suffix(".csv"), details)
    print(f"Inspection report written to: {path}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def command_copy_stored_to_cloud(args: argparse.Namespace) -> int:
    ok, message = ping()
    if not ok:
        print(f"Zotero connector unavailable: {message}", file=sys.stderr)
        return 2
    if args.apply == args.dry_run:
        print("Choose exactly one of --dry-run or --apply", file=sys.stderr)
        return 2

    rows = [attachment_data(item) for item in fetch_all_attachments()]
    details = []
    summary = {
        "checkedAttachments": len(rows),
        "storedCandidates": 0,
        "wouldCopy": 0,
        "copied": 0,
        "alreadyPresent": 0,
        "sourceMissing": 0,
        "skippedHTMLSnapshots": 0,
        "failures": 0,
    }

    for row in rows:
        if is_html_snapshot(row):
            summary["skippedHTMLSnapshots"] += 1
            continue
        if not is_stored_file(row):
            continue
        summary["storedCandidates"] += 1
        src = source_path(args.zotero_data, row)
        dst = cloud_path(args.cloud_root, row)
        detail = {
            **row,
            "sourcePath": str(src),
            "cloudPath": str(dst),
            "relativePath": relative_cloud_path(row),
            "action": "",
        }
        try:
            if not src.exists():
                detail["action"] = "skip-source-missing"
                summary["sourceMissing"] += 1
            elif dst.exists() and dst.stat().st_size == src.stat().st_size:
                detail["action"] = "skip-already-present"
                summary["alreadyPresent"] += 1
            else:
                summary["wouldCopy"] += 1
                if args.apply:
                    ensure_dir(dst.parent)
                    shutil.copy2(src, dst)
                    if dst.stat().st_size != src.stat().st_size:
                        raise RuntimeError("Copied file size mismatch")
                    detail["action"] = "copied"
                    summary["copied"] += 1
                else:
                    detail["action"] = "would-copy"
        except Exception as exc:
            detail["action"] = "failed"
            detail["error"] = str(exc)
            summary["failures"] += 1
        details.append(detail)

    report = {
        "dryRun": args.dry_run,
        "operation": "copy-stored-to-cloud",
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "zoteroDataDir": str(args.zotero_data),
        "cloudRoot": str(args.cloud_root),
        "summary": summary,
        "details": details,
    }
    mode = "DRY_RUN" if args.dry_run else "APPLY"
    path = ensure_dir(args.report_dir) / f"zotero_management_bridge_copy_stored_to_cloud_{mode}_{timestamp()}.json"
    write_json(path, report)
    write_csv(path.with_suffix(".csv"), details)
    print(f"Copy report written to: {path}")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if summary["failures"] else 0


def load_template() -> str:
    template_path = Path(__file__).resolve().parents[2] / "templates" / "zotero_bridge_internal_template.js"
    return template_path.read_text(encoding="utf-8")


def command_make_zotero_js(args: argparse.Namespace) -> int:
    dry_run = args.mode == "dry-run"
    operation = args.operation
    report_name = f"zotero_management_bridge_{operation}_{'DRY_RUN' if dry_run else 'APPLY'}_{timestamp()}_zotero_report.json"
    script_name = f"zotero_management_bridge_{operation}_{'DRY_RUN' if dry_run else 'APPLY'}_{timestamp()}.js"
    report_path = ensure_dir(args.report_dir) / report_name
    script_path = ensure_dir(args.report_dir) / script_name
    text = load_template()
    replacements = {
        "__OPERATION__": operation,
        "__DRY_RUN__": "true" if dry_run else "false",
        "__CLOUD_ROOT__": json.dumps(str(args.cloud_root), ensure_ascii=False),
        "__REPORT_PATH__": json.dumps(str(report_path), ensure_ascii=False),
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    script_path.write_text(text, encoding="utf-8")
    print(f"Zotero-internal script written to: {script_path}")
    print(f"Expected report path: {report_path}")
    return 0


def command_plugin_request(args: argparse.Namespace) -> int:
    request_id = args.id or f"{args.operation}_{timestamp()}_{uuid.uuid4().hex[:8]}"
    queue = args.queue_root
    requests = ensure_dir(queue / "requests")
    responses = ensure_dir(queue / "responses")
    ensure_dir(queue / "processed")
    ensure_dir(queue / "failed")

    request = {
        "id": request_id,
        "operation": args.operation,
        "mode": args.mode,
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "args": {
            "cloudBase": str(args.cloud_root)
        }
    }
    if args.keys:
        request["args"]["keys"] = [key.strip() for key in args.keys.split(",") if key.strip()]
    if args.move:
        request["args"]["move"] = True
    for cli_name, arg_name in [
        ("parent_key", "parentKey"),
        ("file_path", "filePath"),
        ("relative_path", "relativePath"),
        ("title", "title"),
        ("content_type", "contentType"),
    ]:
        value = getattr(args, cli_name, None)
        if value:
            request["args"][arg_name] = value
    if getattr(args, "no_skip_existing", False):
        request["args"]["skipExisting"] = False
    if getattr(args, "skip_date_modified_update", False):
        request["args"]["skipDateModifiedUpdate"] = True

    request_path = requests / f"{request_id}.json"
    response_path = responses / f"{request_id}.json"
    write_json(request_path, request)
    print(f"Plugin request written to: {request_path}")

    if not args.wait:
        print(f"Expected response path: {response_path}")
        return 0

    deadline = time.time() + args.timeout
    while time.time() < deadline:
        if response_path.exists():
            text = response_path.read_text(encoding="utf-8")
            try:
                response = json.loads(text)
                archive_name = f"zotero_management_bridge_plugin_{args.operation}_{request_id}.json"
                archive_path = ensure_dir(args.report_dir) / archive_name
                write_json(archive_path, response)
                summary = response.get("summary")
                print(f"Plugin response written to: {archive_path}")
                if summary is not None:
                    print(json.dumps(summary, ensure_ascii=True, indent=2))
                else:
                    short = {key: response.get(key) for key in ["ok", "zoteroVersion", "pluginVersion", "queueRoot", "cloudBase", "userLibraryID"] if key in response}
                    print(json.dumps(short, ensure_ascii=True, indent=2))
                return 0 if response.get("ok") else 1
            except json.JSONDecodeError:
                raw_path = ensure_dir(args.report_dir) / f"zotero_management_bridge_plugin_{args.operation}_{request_id}.txt"
                raw_path.write_text(text, encoding="utf-8")
                print(f"Plugin returned non-JSON response written to: {raw_path}")
                return 1
        time.sleep(1)
    print(f"Timed out waiting for plugin response: {response_path}", file=sys.stderr)
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Zotero Management Bridge")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--zotero-data", type=Path, default=DEFAULT_ZOTERO_DATA)
    common.add_argument("--cloud-root", type=Path, default=DEFAULT_CLOUD_ROOT)
    common.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("status", parents=[common])
    sub.add_parser("inspect", parents=[common])

    copy_cmd = sub.add_parser("copy-stored-to-cloud", parents=[common])
    mode = copy_cmd.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")

    js_cmd = sub.add_parser("make-zotero-js", parents=[common])
    js_cmd.add_argument("--operation", choices=["create-linked-copies", "cleanup-old-stored"], required=True)
    js_cmd.add_argument("--mode", choices=["dry-run", "apply"], required=True)

    plugin_cmd = sub.add_parser("plugin-request", parents=[common])
    plugin_cmd.add_argument("--operation", choices=[
        "status",
        "inspect",
        "copy-stored-to-cloud",
        "create-linked-copies",
        "cleanup-old-stored",
        "link-file-to-item",
        "import-file-to-item",
        "trash-items-by-key",
        "erase-trash-by-key",
    ], required=True)
    plugin_cmd.add_argument("--mode", choices=["dry-run", "apply"], default="dry-run")
    plugin_cmd.add_argument("--queue-root", type=Path, default=DEFAULT_PLUGIN_QUEUE)
    plugin_cmd.add_argument("--id")
    plugin_cmd.add_argument("--keys", help="Comma-separated Zotero item keys for key-targeted operations")
    plugin_cmd.add_argument("--parent-key", help="Parent Zotero item key for attachment operations")
    plugin_cmd.add_argument("--file-path", help="Absolute file path for attachment operations")
    plugin_cmd.add_argument("--relative-path", help="Path relative to the linked attachment base directory")
    plugin_cmd.add_argument("--title", help="Attachment title")
    plugin_cmd.add_argument("--content-type", help="Attachment content type such as application/pdf")
    plugin_cmd.add_argument("--move", action="store_true", help="Move files instead of copying where supported")
    plugin_cmd.add_argument("--no-skip-existing", action="store_true", help="Allow duplicate attachment creation")
    plugin_cmd.add_argument("--skip-date-modified-update", action="store_true", help="Avoid updating the parent item modified date when supported")
    plugin_cmd.add_argument("--wait", action="store_true")
    plugin_cmd.add_argument("--timeout", type=int, default=60)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "status":
        return command_status(args)
    if args.command == "inspect":
        return command_inspect(args)
    if args.command == "copy-stored-to-cloud":
        return command_copy_stored_to_cloud(args)
    if args.command == "make-zotero-js":
        return command_make_zotero_js(args)
    if args.command == "plugin-request":
        return command_plugin_request(args)
    parser.error("Unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

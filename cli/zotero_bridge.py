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
STORED_LINK_MODES = {"imported_file", "imported_url"}


def default_plugin_queue() -> Path:
    configured = os.environ.get("ZMB_QUEUE_ROOT")
    if configured:
        return Path(configured)
    appdata = os.environ.get("APPDATA")
    if appdata:
        profiles = Path(appdata) / "Zotero" / "Zotero" / "Profiles"
        candidates = list(profiles.glob("*/zotero-management-bridge/queue/bridge_status.json"))
        if candidates:
            latest = max(candidates, key=lambda path: path.stat().st_mtime)
            return latest.parent
        queue_dirs = list(profiles.glob("*/zotero-management-bridge/queue"))
        if queue_dirs:
            latest = max(queue_dirs, key=lambda path: path.stat().st_mtime)
            return latest
    return Path.home() / ".zotero-management-bridge" / "queue"


DEFAULT_PLUGIN_QUEUE = default_plugin_queue()


def load_args_json(value: str | None) -> dict:
    if not value:
        return {}
    source = "inline --args-json"
    if value.startswith("@"):
        path = Path(value[1:])
        source = f"@{path}"
        text = path.read_text(encoding="utf-8-sig")
    else:
        text = value
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        if '\\"' not in text:
            raise ValueError(f"Could not parse JSON from {source}: {exc}") from exc
        try:
            data = json.loads(text.replace('\\"', '"'))
        except json.JSONDecodeError as retry_exc:
            raise ValueError(f"Could not parse JSON from {source}: {retry_exc}") from retry_exc
    if not isinstance(data, dict):
        raise ValueError("--args-json must decode to a JSON object")
    return data


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
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=8) as resp:
        text = resp.read().decode("utf-8")
        return json.loads(text), resp.headers


def http_get_text(path: str) -> str:
    req = urllib.request.Request(CONNECTOR + path)
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


def command_plugin_request(args: argparse.Namespace) -> int:
    request_args = load_args_json(args.args_json)
    if args.cloud_root and "cloudBase" not in request_args:
        request_args["cloudBase"] = str(args.cloud_root)
    if args.keys:
        request_args["keys"] = [key.strip() for key in args.keys.split(",") if key.strip()]
    if args.move:
        request_args["move"] = True
    for cli_name, arg_name in [
        ("parent_key", "parentKey"),
        ("file_path", "filePath"),
        ("relative_path", "relativePath"),
        ("title", "title"),
        ("content_type", "contentType"),
        ("query", "query"),
        ("doi", "doi"),
        ("item_type", "itemType"),
        ("year", "year"),
        ("url", "url"),
        ("date", "date"),
        ("publication_title", "publicationTitle"),
        ("journal_abbreviation", "journalAbbreviation"),
        ("collection_key", "collectionKey"),
        ("collection_name", "collectionName"),
    ]:
        value = getattr(args, cli_name, None)
        if value:
            request_args[arg_name] = value
    if getattr(args, "limit", None):
        request_args["limit"] = args.limit
    if getattr(args, "creators_json", None):
        request_args["creators"] = load_args_json(args.creators_json).get("creators", [])
    if getattr(args, "tags", None):
        request_args["tags"] = [tag.strip() for tag in args.tags.split(",") if tag.strip()]
    if getattr(args, "no_skip_existing", False):
        request_args["skipExisting"] = False
    if getattr(args, "skip_date_modified_update", False):
        request_args["skipDateModifiedUpdate"] = True

    request_id = args.id or make_request_id(args.operation)
    request, request_path, response_path = write_plugin_request(
        queue_root=args.queue_root,
        operation=args.operation,
        mode=args.mode,
        request_args=request_args,
        request_id=request_id,
    )
    print(f"Plugin request written to: {request_path}")

    if not args.wait:
        print(f"Expected response path: {response_path}")
        return 0

    try:
        response = wait_for_plugin_response(response_path, args.timeout)
    except TimeoutError:
        print(f"Timed out waiting for plugin response: {response_path}", file=sys.stderr)
        return 2
    except json.JSONDecodeError:
        raw_path = ensure_dir(args.report_dir) / f"zotero_management_bridge_plugin_{args.operation}_{request_id}.txt"
        raw_path.write_text(response_path.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"Plugin returned non-JSON response written to: {raw_path}")
        return 1

    archive_name = f"zotero_management_bridge_plugin_{args.operation}_{request_id}.json"
    archive_path = ensure_dir(args.report_dir) / archive_name
    write_json(archive_path, response)
    summary = response.get("summary")
    print(f"Plugin response written to: {archive_path}")
    if summary is not None:
        print(json.dumps(summary, ensure_ascii=True, indent=2))
        if getattr(args, "print_items", False) and isinstance(response.get("items"), list):
            for item in response["items"][: int(args.print_items_limit or 20)]:
                fields = item.get("fields", {}) if isinstance(item, dict) else {}
                print("\t".join([
                    str(item.get("key", "")),
                    str(fields.get("DOI", "")),
                    str(fields.get("date", "")),
                    str(item.get("title") or fields.get("title", "")),
                ]))
    else:
        short = {key: response.get(key) for key in ["ok", "zoteroVersion", "pluginVersion", "queueRoot", "cloudBase", "userLibraryID"] if key in response}
        print(json.dumps(short, ensure_ascii=True, indent=2))
    return 0 if response.get("ok") else 1


def make_request_id(operation: str) -> str:
    return f"{operation}_{timestamp()}_{uuid.uuid4().hex[:8]}"


def write_plugin_request(
    queue_root: Path,
    operation: str,
    mode: str = "dry-run",
    request_args: dict | None = None,
    request_id: str | None = None,
) -> tuple[dict, Path, Path]:
    request_id = request_id or make_request_id(operation)
    requests = ensure_dir(queue_root / "requests")
    responses = ensure_dir(queue_root / "responses")
    ensure_dir(queue_root / "processed")
    ensure_dir(queue_root / "failed")
    request = {
        "id": request_id,
        "operation": operation,
        "mode": mode,
        "createdAt": dt.datetime.now().isoformat(timespec="seconds"),
        "args": request_args or {},
    }
    request_path = requests / f"{request_id}.json"
    response_path = responses / f"{request_id}.json"
    write_json(request_path, request)
    return request, request_path, response_path


def wait_for_plugin_response(response_path: Path, timeout: int | float = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if response_path.exists():
            return json.loads(response_path.read_text(encoding="utf-8"))
        time.sleep(0.25)
    raise TimeoutError(str(response_path))


def submit_plugin_request(
    operation: str,
    mode: str = "dry-run",
    request_args: dict | None = None,
    queue_root: Path | None = None,
    timeout: int | float = 60,
    request_id: str | None = None,
) -> dict:
    _request, _request_path, response_path = write_plugin_request(
        queue_root=queue_root or DEFAULT_PLUGIN_QUEUE,
        operation=operation,
        mode=mode,
        request_args=request_args or {},
        request_id=request_id,
    )
    return wait_for_plugin_response(response_path, timeout)


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

    plugin_cmd = sub.add_parser("plugin-request", parents=[common])
    plugin_cmd.add_argument("--operation", required=True, help="Bridge operation name, for example status or metadata-audit")
    plugin_cmd.add_argument("--mode", choices=["dry-run", "apply"], default="dry-run")
    plugin_cmd.add_argument("--queue-root", type=Path, default=DEFAULT_PLUGIN_QUEUE)
    plugin_cmd.add_argument("--id")
    plugin_cmd.add_argument("--args-json", help="JSON object, or @path-to-json, merged into request args before shortcut flags")
    plugin_cmd.add_argument("--keys", help="Comma-separated Zotero item keys for key-targeted operations")
    plugin_cmd.add_argument("--parent-key", help="Parent Zotero item key for attachment operations")
    plugin_cmd.add_argument("--file-path", help="Absolute file path for attachment operations")
    plugin_cmd.add_argument("--relative-path", help="Path relative to the linked attachment base directory")
    plugin_cmd.add_argument("--title", help="Attachment title")
    plugin_cmd.add_argument("--content-type", help="Attachment content type such as application/pdf")
    plugin_cmd.add_argument("--query", help="Shortcut for args.query")
    plugin_cmd.add_argument("--doi", help="Shortcut for args.doi / DOI")
    plugin_cmd.add_argument("--item-type", help="Shortcut for args.itemType")
    plugin_cmd.add_argument("--year", help="Shortcut for args.year")
    plugin_cmd.add_argument("--limit", type=int, help="Shortcut for args.limit")
    plugin_cmd.add_argument("--url", help="Shortcut for args.url")
    plugin_cmd.add_argument("--date", help="Shortcut for args.date")
    plugin_cmd.add_argument("--publication-title", help="Shortcut for args.publicationTitle")
    plugin_cmd.add_argument("--journal-abbreviation", help="Shortcut for args.journalAbbreviation")
    plugin_cmd.add_argument("--collection-key", help="Shortcut for args.collectionKey")
    plugin_cmd.add_argument("--collection-name", help="Shortcut for args.collectionName")
    plugin_cmd.add_argument("--creators-json", help="JSON object or @file containing a creators array")
    plugin_cmd.add_argument("--tags", help="Comma-separated tag names")
    plugin_cmd.add_argument("--print-items", action="store_true", help="Print a compact item table for responses with items")
    plugin_cmd.add_argument("--print-items-limit", type=int, default=20)
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
    if args.command == "plugin-request":
        return command_plugin_request(args)
    parser.error("Unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

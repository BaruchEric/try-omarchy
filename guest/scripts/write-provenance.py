#!/usr/bin/env python3
"""Write deterministic content digests for the authentic Omarchy payload."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def digest_path(path: Path) -> str:
    digest = hashlib.sha256()
    for current, directories, files in os.walk(path, topdown=True, followlinks=False):
        directories.sort()
        files.sort()
        base = Path(current)
        for name in directories + files:
            item = base / name
            relative = item.relative_to(path).as_posix()
            if item.is_symlink():
                kind = b"L"
                payload = os.readlink(item).encode()
            elif item.is_dir():
                kind = b"D"
                payload = b""
            else:
                kind = b"F"
                payload = item.read_bytes()
            digest.update(kind)
            digest.update(relative.encode())
            digest.update(b"\0")
            digest.update(payload)
            digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--spec", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    spec = json.loads(args.spec.read_text())
    omarchy = args.root / "usr/share/omarchy"
    trees = {}
    for name in spec["authenticity"]["verbatimRuntimeTrees"]:
        installed = omarchy / name
        if not installed.exists():
            raise SystemExit(f"missing installed authenticity tree: {installed}")
        trees[name] = digest_path(installed)
    trees["themes"] = digest_path(omarchy / "themes")

    payload = {
        "schemaVersion": 1,
        "claim": "Desktop runtime copied from the pinned Basecamp Omarchy source; web changes are user-level overrides.",
        "upstream": spec["upstream"],
        "includedThemes": spec["themes"],
        "sha256Trees": trees,
    }
    source_digest = args.root / "usr/share/try-omarchy/upstream-tree.json"
    if source_digest.exists():
        payload["normalizedUpstreamTree"] = json.loads(source_digest.read_text())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Normalize a git checkout into the guest-report v1 source digest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

ALGORITHM = "omarchy-git-tree-sha256-v1:path-nul-mode-nul-length-nul-content-nul"


def git(source: Path, *arguments: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(source), *arguments])


def digest_source(source: Path) -> tuple[str, int]:
    records = git(source, "ls-files", "-s", "-z").split(b"\0")
    entries: list[tuple[bytes, bytes, bytes]] = []
    for record in records:
        if not record:
            continue
        metadata, raw_path = record.split(b"\t", 1)
        mode = metadata.split(b" ", 1)[0]
        relative = os.fsdecode(raw_path)
        path = source / relative
        if mode == b"120000":
            content = os.readlink(path).encode("utf-8", "surrogateescape")
        else:
            content = path.read_bytes()
        entries.append((raw_path, mode, content))

    entries.sort(key=lambda item: item[0])
    digest = hashlib.sha256()
    digest.update(ALGORITHM.encode() + b"\0")
    for path, mode, content in entries:
        digest.update(path)
        digest.update(b"\0")
        digest.update(mode)
        digest.update(b"\0")
        digest.update(str(len(content)).encode())
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
    return digest.hexdigest(), len(entries)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    digest, files = digest_source(args.source)
    payload = {"algorithm": ALGORITHM, "files": files, "sha256": digest}
    rendered = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    else:
        print(rendered, end="")


if __name__ == "__main__":
    main()

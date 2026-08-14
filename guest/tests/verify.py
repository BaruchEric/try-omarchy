#!/usr/bin/env python3
"""Dependency-free static and pinned-source tests for the guest pipeline."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

GUEST = pathlib.Path(__file__).resolve().parents[1]
SPEC = json.loads((GUEST / "spec.json").read_text())
FAILURES: list[str] = []


def check(condition: bool, label: str) -> None:
    if condition:
        print(f"PASS {label}")
    else:
        print(f"FAIL {label}")
        FAILURES.append(label)


def entries(path: pathlib.Path) -> list[str]:
    values = []
    for line in path.read_text().splitlines():
        value = line.split("#", 1)[0].strip()
        if value:
            values.append(value)
    return values


def run(*argv: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(value) for value in argv], text=True, capture_output=True, check=False, **kwargs)


def test_static() -> None:
    check(SPEC["schemaVersion"] == 1, "guest spec schema")
    check(SPEC["image"]["architecture"] == "x86_64", "x86_64 guest architecture")
    display = SPEC["guest"]["virtualDisplay"]
    check((display["width"], display["height"], display["scale"]) == (1600, 900, 1), "fixed 1600x900 pixel-sharp display")
    check(re.fullmatch(r"[0-9a-f]{40}", SPEC["upstream"]["commit"]) is not None, "immutable upstream commit")
    check(re.fullmatch(r"[0-9a-f]{64}", SPEC["upstream"]["treeSha256"]) is not None, "normalized source digest pinned")

    packages = entries(GUEST / SPEC["inputs"]["packages"])
    check(packages == sorted(set(packages)), "package list sorted and unique")
    required = {
        "base", "chromium", "foot", "hyprland", "linux", "mesa", "neovim",
        "networkmanager", "omarchy-nvim", "quickshell-git", "uwsm", "vulkan-swrast",
        "xdg-desktop-portal-hyprland", "xdg-terminal-exec",
    }
    check(required <= set(packages), "real desktop packages retained")
    forbidden = {
        "bluez", "bolt", "cups", "docker", "kdenlive", "libreoffice-fresh",
        "nvidia-dkms", "obs-studio", "power-profiles-daemon", "steam",
    }
    check(not (forbidden & set(packages)), "heavy and physical-hardware packages trimmed")
    package_lock = json.loads((GUEST / SPEC["inputs"]["packageLock"]).read_text())
    lock_names = list(package_lock["packages"])
    package_sha = hashlib.sha256((GUEST / SPEC["inputs"]["packages"]).read_bytes()).hexdigest()
    check(package_lock["architecture"] == "x86_64" and package_lock["requestedFileSha256"] == package_sha, "package lock matches requested package input")
    check(lock_names == sorted(lock_names) and len(lock_names) > 500, "complete transitive package transaction is version-locked")
    check(set(packages) <= set(lock_names) and "glibc" in lock_names, "package lock covers explicit and base dependencies")

    for key in ("maskedSystemServices", "maskedUserServices"):
        units = entries(GUEST / SPEC["inputs"][key])
        check(units == sorted(set(units)), f"{key} sorted and unique")
    system_masks = set(entries(GUEST / SPEC["inputs"]["maskedSystemServices"]))
    check({"suspend.target", "hibernate.target", "docker.service", "bluetooth.service"} <= system_masks, "unsupported system actions masked")

    scripts = sorted((GUEST / "scripts").glob("*.sh")) + [GUEST / "build.sh", GUEST / "build-container.sh"]
    for script in scripts:
        result = run("bash", "-n", script)
        check(result.returncode == 0, f"shell syntax: {script.relative_to(GUEST)}")
    python_files = sorted((GUEST / "scripts").glob("*.py")) + [GUEST / "overlay/usr/local/bin/omarchy-web-guest-probe"]
    for script in python_files:
        try:
            ast.parse(script.read_text(), filename=str(script))
            valid = True
        except SyntaxError:
            valid = False
        check(valid, f"python syntax: {script.relative_to(GUEST)}")

    extension = (GUEST / "overlay/etc/skel/.config/omarchy/extensions/omarchy-menu.jsonc").read_text()
    extension_json = re.sub(r"^\s*//.*$", "", extension, flags=re.MULTILINE)
    try:
        menu = json.loads(extension_json)
        menu_valid = True
    except json.JSONDecodeError:
        menu = {}
        menu_valid = False
    check(menu_valid, "demo menu extension is valid JSONC")
    check(all(menu.get(item, {}).get("when") == "false" for item in ("install", "remove", "setup", "system", "update")), "privileged menu roots hidden through supported extension")

    probe = (GUEST / "overlay/usr/local/bin/omarchy-web-guest-probe").read_text()
    required_commands = json.loads((GUEST.parent / "scripts/verification/acceptance-contract.json").read_text()).get("requiredGuestCommands", []) if (GUEST.parent / "scripts/verification/acceptance-contract.json").exists() else []
    check(all(repr(command.split()) in probe or json.dumps(command.split()) in probe for command in required_commands), "probe contains acceptance identity commands")


def test_source(source: pathlib.Path) -> None:
    check((source / ".git").is_dir(), "pinned source is a git checkout")
    commit = run("git", "-C", source, "rev-parse", "HEAD").stdout.strip()
    tree = run("git", "-C", source, "rev-parse", "HEAD^{tree}").stdout.strip()
    check(commit == SPEC["upstream"]["commit"], "source commit matches spec")
    check(tree == SPEC["upstream"]["tree"], "source git tree matches spec")
    check(not run("git", "-C", source, "status", "--porcelain", "--untracked-files=all").stdout.strip(), "source checkout clean")
    check(all((source / path).exists() for path in SPEC["authenticity"]["requiredPaths"]), "authentic runtime source paths present")

    digest_result = run(GUEST / "scripts/source-digest.py", "--source", source)
    digest = json.loads(digest_result.stdout) if digest_result.returncode == 0 else {}
    check(digest.get("sha256") == SPEC["upstream"]["treeSha256"], "normalized upstream source digest")

    with tempfile.TemporaryDirectory(prefix="omarchy-guest-test.") as temporary:
        root = pathlib.Path(temporary)
        materialize = run(GUEST / "scripts/materialize-omarchy.sh", "--root", root, "--source", source)
        check(materialize.returncode == 0, "materialize pinned Omarchy payload")
        if materialize.returncode != 0:
            print(materialize.stderr)
            return
        configure = run(GUEST / "scripts/configure-rootfs.sh", "--root", root)
        check(configure.returncode == 0, "apply disposable virtual-hardware profile")
        if configure.returncode != 0:
            print(configure.stderr)
            return

        exact = [
            "shell/shell.qml",
            "default/hypr/omarchy.lua",
            "default/omarchy/omarchy-menu.jsonc",
            "config/hypr/hyprland.lua",
        ]
        check(all((source / path).read_bytes() == (root / "usr/share/omarchy" / path).read_bytes() for path in exact), "critical shell and Hyprland runtime files byte-identical")
        commands_exact = all(
            command.read_bytes() == (root / "usr/bin" / command.name).read_bytes()
            and (root / "usr/share/omarchy/bin" / command.name).is_symlink()
            for command in (source / "bin").iterdir() if command.is_file()
        )
        check(commands_exact, "all upstream omarchy commands byte-identical and linked")

        monitors = (root / "etc/skel/.config/hypr/monitors.lua").read_bytes()
        expected_monitors = (source / "config/hypr/monitors.lua").read_bytes() + (GUEST / "fragments/hypr-monitors.append.lua").read_bytes()
        check(monitors == expected_monitors, "monitor profile is an additive user override")
        autostart = (root / "etc/skel/.config/hypr/autostart.lua").read_bytes()
        expected_autostart = (source / "config/hypr/autostart.lua").read_bytes() + (GUEST / "fragments/hypr-autostart.append.lua").read_bytes()
        check(autostart == expected_autostart, "welcome is an additive user override")

        hidden_webapps = {
            "Basecamp.desktop", "Discord.desktop", "Docker.desktop",
            "Google Contacts.desktop", "Google Maps.desktop", "Google Messages.desktop",
            "Google Photos.desktop", "HEY.desktop", "WhatsApp.desktop", "X.desktop",
            "YouTube.desktop", "Zoom.desktop",
        }
        app_dir = root / "etc/skel/.local/share/applications"
        check(all("Hidden=true" in (app_dir / name).read_text() for name in hidden_webapps), "offline and unavailable app launchers hidden at user layer")

        included = sorted(path.name for path in (root / "usr/share/omarchy/themes").iterdir() if path.is_dir())
        check(included == SPEC["themes"], "only selected authentic themes included")
        system_masks = entries(GUEST / SPEC["inputs"]["maskedSystemServices"])
        check(all((root / "etc/systemd/system" / unit).is_symlink() and os.readlink(root / "etc/systemd/system" / unit) == "/dev/null" for unit in system_masks), "system service masks materialized")
        user_masks = entries(GUEST / SPEC["inputs"]["maskedUserServices"])
        check(all((root / "etc/skel/.config/systemd/user" / unit).is_symlink() and os.readlink(root / "etc/skel/.config/systemd/user" / unit) == "/dev/null" for unit in user_masks), "user service masks materialized")

        provenance = json.loads((root / "usr/share/omarchy-web/provenance.json").read_text())
        check(provenance["normalizedUpstreamTree"]["sha256"] == SPEC["upstream"]["treeSha256"], "staged provenance records pinned source")
        check(provenance["sha256Trees"]["shell"], "staged shell content digest recorded")
        check((root / "usr/local/bin/omarchy-web-guest-probe").exists(), "live authenticity probe installed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path)
    args = parser.parse_args()
    test_static()
    if args.source:
        test_source(args.source.resolve())
    if FAILURES:
        raise SystemExit(f"{len(FAILURES)} guest pipeline checks failed")
    print(f"All guest pipeline checks passed ({'deep' if args.source else 'static'} mode).")


if __name__ == "__main__":
    main()

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
import runpy
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

    probe_namespace = runpy.run_path(str(GUEST / "overlay/usr/local/bin/omarchy-web-guest-probe"))
    framed_report = probe_namespace["diagnostic_frame"]({"schemaVersion": 1, "source": "guest"})
    serial_with_prompt = "omarchy-web login: " + framed_report
    report_lines = [line for line in serial_with_prompt.splitlines() if line.startswith("OMARCHY_GUEST_REPORT ")]
    framed_payload = json.loads(report_lines[0].removeprefix("OMARCHY_GUEST_REPORT ")) if len(report_lines) == 1 else {}
    check(framed_report.startswith("\r\nOMARCHY_GUEST_REPORT ") and framed_report.endswith("\r\n") and framed_payload == {"schemaVersion": 1, "source": "guest"}, "serial guest report starts on a fresh framed line after a getty prompt")

    finalize = (GUEST / "scripts/finalize-rootfs.sh").read_text()
    default_link = "ln -sfn /usr/lib/systemd/system/graphical.target /etc/systemd/system/default.target"
    check("systemctl set-default" not in finalize and default_link in finalize, "graphical default target is materialized without systemctl")
    with tempfile.TemporaryDirectory(prefix="omarchy-default-target.") as temporary:
        systemd = pathlib.Path(temporary) / "etc/systemd/system"
        systemd.mkdir(parents=True)
        link = systemd / "default.target"
        link.symlink_to("/usr/lib/systemd/system/multi-user.target")
        replace = run("ln", "-sfn", "/usr/lib/systemd/system/graphical.target", link)
        check(replace.returncode == 0 and link.is_symlink() and os.readlink(link) == "/usr/lib/systemd/system/graphical.target", "graphical default target replaces an existing default exactly")

    build = (GUEST / "build.sh").read_text()
    configure = (GUEST / "scripts/configure-rootfs.sh").read_text()
    identity = (GUEST / "scripts/register-omarchy-runtime.sh").read_text()
    identity_call = '"$guest_dir/scripts/register-omarchy-runtime.sh"'
    check(identity_call in build and build.find(identity_call) < build.find('arch-chroot "$root" /usr/local/lib/omarchy-web/finalize-rootfs'), "local Omarchy runtime package is registered before guest finalization")
    check("package_name=omarchy-web-runtime" in identity and "provides = omarchy=$version" in identity and "-U --dbonly" in identity, "local package transparently provides the official Omarchy identity")
    check('cp -a "$root/usr/share/omarchy"' in identity and 'cp -a "$command"' in identity and '-Qk "$package_name"' in identity, "local package owns and verifies the exact staged Omarchy runtime")
    check('package_cache="$work/pacman-cache"' in build and 'CacheDir = %s\\n' in build, "package cache is persistent under the selected work storage")
    check('pacstrap -c -P -C "$pacman_config"' in build, "pacstrap uses its configured host-cache mode")
    check('if [[ ${OMARCHY_PACMAN_DISABLE_SANDBOX:-0} == "1" ]]' in build and "printf 'DisableSandbox\\n'" in build, "emulated builder sandbox override remains conditional")
    pinned_guest_config = 'install -m 0644 "$root/usr/share/omarchy/default/pacman/pacman-stable.conf" "$root/etc/pacman.conf"'
    check(pinned_guest_config in configure, "guest receives the unmodified pinned pacman configuration")
    check('rmdir "$staged_package_cache"' in build and 'rm -rf "$package_cache"' not in build and 'rm -f "$package_cache"' not in build, "persistent package cache is never deleted by the build")

    resolver_link = 'ln -sfn ../run/systemd/resolve/stub-resolv.conf "$root/etc/resolv.conf"'
    resolver_index = build.find(resolver_link)
    check(resolver_link not in finalize and build.count(resolver_link) == 1, "resolver symlink is materialized outside the chroot")
    check(build.rfind("arch-chroot ") < resolver_index < build.find('"$guest_dir/scripts/pack-image.sh"'), "resolver symlink follows every chroot and precedes image packing")
    with tempfile.TemporaryDirectory(prefix="omarchy-resolver-link.") as temporary:
        resolv_conf = pathlib.Path(temporary) / "etc/resolv.conf"
        resolv_conf.parent.mkdir(parents=True)
        resolv_conf.write_text("nameserver 192.0.2.1\n")
        target = "../run/systemd/resolve/stub-resolv.conf"
        replace = run("ln", "-sfn", target, resolv_conf)
        repeat = run("ln", "-sfn", target, resolv_conf)
        check(replace.returncode == 0 and repeat.returncode == 0 and resolv_conf.is_symlink() and os.readlink(resolv_conf) == target, "resolver symlink replaces chroot file idempotently")

    with tempfile.TemporaryDirectory(prefix="omarchy-container-plan.") as temporary:
        scratch = pathlib.Path(temporary)
        output = scratch / "output-not-created"
        work = scratch / "work-not-created"
        base_env = os.environ.copy()

        linux_env = {**base_env, "OMARCHY_CONTAINER_HOST_OS": "Linux"}
        linux = run(GUEST / "build-container.sh", "--dry-run", "--output", output, env=linux_env)
        check(linux.returncode == 0 and "work-storage=bind" in linux.stdout, "container builder keeps native Linux bind work path")

        desktop_env = {**base_env, "OMARCHY_CONTAINER_HOST_OS": "Darwin"}
        desktop = run(GUEST / "build-container.sh", "--dry-run", "--output", output, env=desktop_env)
        volume_match = re.search(r"^work-source=(omarchy-web-guest-work-[0-9]+)$", desktop.stdout, re.MULTILINE)
        check(desktop.returncode == 0 and "work-storage=volume" in desktop.stdout and volume_match is not None, "Docker Desktop defaults to persistent managed work volume")
        check(not output.exists() and not work.exists(), "container dry run has no filesystem side effects")

        named = run(GUEST / "build-container.sh", "--dry-run", "--work-volume", "omarchy-test-cache", env=desktop_env)
        check(named.returncode == 0 and "work-source=omarchy-test-cache" in named.stdout, "explicit Docker work volume accepted")

        unsafe_bind = run(GUEST / "build-container.sh", "--dry-run", "--work", work, env=desktop_env)
        check(unsafe_bind.returncode != 0 and "unsafe for a pacstrap rootfs" in unsafe_bind.stderr, "Docker Desktop host work bind rejected")

        conflict = run(GUEST / "build-container.sh", "--dry-run", "--work", work, "--work-volume", "omarchy-test-cache", env=linux_env)
        check(conflict.returncode != 0 and "mutually exclusive" in conflict.stderr, "container work storage options are mutually exclusive")

        invalid = run(GUEST / "build-container.sh", "--dry-run", "--work-volume", "bad/volume", env=desktop_env)
        check(invalid.returncode != 0 and "invalid Docker volume name" in invalid.stderr, "unsafe Docker volume name rejected")

        wrapper = (GUEST / "build-container.sh").read_text()
        check("docker volume rm" not in wrapper and "rm -rf" not in wrapper, "container wrapper never deletes existing work storage")


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

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
import sys
import tempfile
from collections.abc import Iterable

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
    diagnostic_candidates = probe_namespace["_diagnostic_candidates"]
    check(
        diagnostic_candidates("aarch64")
        == [
            pathlib.Path("/dev/virtio-ports/omarchy.web.diagnostics"),
            pathlib.Path("/dev/hvc0"),
            pathlib.Path("/dev/ttyS0"),
        ]
        and diagnostic_candidates("arm64")[1:] == [
            pathlib.Path("/dev/hvc0"),
            pathlib.Path("/dev/ttyS0"),
        ]
        and diagnostic_candidates("x86_64")[1:] == [
            pathlib.Path("/dev/ttyS0"),
            pathlib.Path("/dev/hvc0"),
        ],
        "diagnostic fallback prioritizes Apple's connected hvc0 console on ARM and ttyS0 on x86",
    )

    with tempfile.TemporaryDirectory(prefix="omarchy-stage-protocol.") as temporary:
        state_path = pathlib.Path(temporary) / "stage-state.json"
        first, first_stream = probe_namespace["_stage_payloads"](
            [
                ("autologin", "ready", 1, "tty1 ready"),
                ("uwsm", "started", 1, "upstream command"),
            ],
            state_path=state_path,
            monotonic=lambda: 12.5,
        )
        first_stream.close()
        second, second_stream = probe_namespace["_stage_payloads"](
            [("hyprland", "waiting", 2, "waiting\nfor compositor")],
            state_path=state_path,
            monotonic=lambda: 1.0,
        )
        second_stream.close()
        stages = first + second
        expected_stage_keys = {
            "schemaVersion", "sequence", "monotonicMs", "stage", "status", "attempt", "message",
        }
        check(
            [stage["sequence"] for stage in stages] == [1, 2, 3]
            and all(
                left["monotonicMs"] < right["monotonicMs"]
                for left, right in zip(stages, stages[1:])
            )
            and all(set(stage) == expected_stage_keys for stage in stages)
            and stages[-1]["message"] == "waiting for compositor",
            "guest startup stages have locked sequence and strictly monotonic timestamps",
        )
        stage_frame = probe_namespace["diagnostic_frame"](
            stages[0],
            probe_namespace["STAGE_PREFIX"],
        )
        parsed_stage = json.loads(stage_frame.split("OMARCHY_GUEST_STAGE ", 1)[1].strip())
        check(
            stage_frame.startswith("\r\nOMARCHY_GUEST_STAGE ")
            and stage_frame.endswith("\r\n")
            and parsed_stage == stages[0],
            "guest startup stage is one CRLF-framed strict JSON line",
        )
        bounded_message = probe_namespace["bounded_stage_message"]("é" * 600)
        bounded_frame = probe_namespace["diagnostic_frame"](
            {**stages[0], "message": bounded_message},
            probe_namespace["STAGE_PREFIX"],
        )
        check(
            len(bounded_message.encode()) <= 512
            and bounded_message.endswith("...")
            and len(bounded_frame.encode()) <= 2048,
            "guest stage diagnostic messages stay within the parser byte bound",
        )
        stored_state = json.loads(state_path.read_text())
        check(
            set(stored_state) == probe_namespace["STATE_KEYS"]
            and stored_state["sequence"] == 3
            and stored_state["reportPendingSha256"] is None
            and stored_state["reportDeliveredSha256"] is None
            and (state_path.stat().st_mode & 0o777) == 0o600
            and not list(state_path.parent.glob(".*.tmp")),
            "stage state is private, exact, and atomically replaced",
        )

        state_path.write_text("{interrupted")
        corrupt_rejected = False
        try:
            probe_namespace["_stage_payloads"](
                [("uwsm", "waiting", 3, "must not reset")],
                state_path=state_path,
            )
        except RuntimeError:
            corrupt_rejected = True
        check(
            corrupt_rejected and state_path.read_text() == "{interrupted",
            "truncated stage state fails closed instead of resetting sequence",
        )

    with tempfile.TemporaryDirectory(prefix="omarchy-stage-symlink.") as temporary:
        scratch = pathlib.Path(temporary)
        victim = scratch / "victim"
        victim.write_text("unchanged")
        state_link = scratch / "stage-state.json"
        state_link.symlink_to(victim)
        symlink_rejected = False
        try:
            probe_namespace["_stage_payloads"](
                [("autologin", "ready", 1, "unsafe state")],
                state_path=state_link,
            )
        except OSError:
            symlink_rejected = True
        check(
            symlink_rejected and victim.read_text() == "unchanged",
            "stage state never follows a symlink",
        )

    with tempfile.TemporaryDirectory(prefix="omarchy-stage-concurrent.") as temporary:
        workers = []
        worker_environment = {**os.environ, "XDG_RUNTIME_DIR": temporary}
        for attempt in range(1, 7):
            workers.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        str(GUEST / "overlay/usr/local/bin/omarchy-web-guest-probe"),
                        "--stage",
                        "uwsm",
                        "--status",
                        "waiting",
                        "--attempt",
                        str(attempt),
                        "--message",
                        "concurrent observer",
                    ],
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=worker_environment,
                )
            )
        worker_results = [worker.communicate(timeout=20) for worker in workers]
        concurrent_state = json.loads(
            (
                pathlib.Path(temporary)
                / "omarchy-web/stage-state.json"
            ).read_text()
        )
        check(
            all(worker.returncode == 0 for worker in workers)
            and all(not stderr for _stdout, stderr in worker_results)
            and concurrent_state["sequence"] == len(workers)
            and concurrent_state["monotonicMs"] >= len(workers) - 1,
            "concurrent observer processes serialize monotonic stage state",
        )

    fake_a = pathlib.Path("/dev/fake-a")
    fake_b = pathlib.Path("/dev/fake-b")
    short_bytes = bytearray()

    def short_writer(_descriptor: int, value: bytes) -> int:
        written = min(2, len(value))
        short_bytes.extend(value[:written])
        return written

    short_target = probe_namespace["_write_frames"](
        ["abcdef"],
        candidates=[fake_a],
        opener=lambda _path, _flags: 41,
        writer=short_writer,
        closer=lambda _descriptor: None,
    )
    check(
        short_target == fake_a and bytes(short_bytes) == b"abcdef",
        "diagnostics writer completes bounded short writes on one device",
    )

    opened_candidates = []
    partial_calls = 0

    def partial_opener(path: pathlib.Path, _flags: int) -> int:
        opened_candidates.append(path)
        return 42

    def partial_writer(_descriptor: int, _value: bytes) -> int:
        nonlocal partial_calls
        partial_calls += 1
        if partial_calls == 1:
            return 2
        raise OSError("forced device failure")

    partial_rejected = False
    try:
        probe_namespace["_write_frames"](
            ["abcdef"],
            candidates=[fake_a, fake_b],
            opener=partial_opener,
            writer=partial_writer,
            closer=lambda _descriptor: None,
        )
    except probe_namespace["PartialDiagnosticWrite"]:
        partial_rejected = True
    check(
        partial_rejected and opened_candidates == [fake_a],
        "a partial diagnostics frame never falls through and duplicates on another port",
    )

    with tempfile.TemporaryDirectory(prefix="omarchy-stage-partial.") as temporary:
        state_path = pathlib.Path(temporary) / "stage-state.json"
        poisoned_writes = []

        def poison_stage(frames: Iterable[str]) -> pathlib.Path:
            poisoned_writes.append(list(frames))
            raise probe_namespace["PartialDiagnosticWrite"](fake_a, 3, 100)

        stage_interrupted = False
        try:
            probe_namespace["emit_stages"](
                [("uwsm", "waiting", 1, "partial stage")],
                state_path=state_path,
                write_frames=poison_stage,
            )
        except probe_namespace["PartialDiagnosticWrite"]:
            stage_interrupted = True
        further_stage_blocked = False
        try:
            probe_namespace["emit_stages"](
                [("uwsm", "waiting", 2, "must not follow partial")],
                state_path=state_path,
                write_frames=poison_stage,
            )
        except RuntimeError:
            further_stage_blocked = True
        poisoned_state = json.loads(state_path.read_text())
        check(
            stage_interrupted
            and further_stage_blocked
            and len(poisoned_writes) == 1
            and poisoned_state["diagnosticsPoisoned"] is True,
            "partial stage output poisons durable state and prevents parser corruption",
        )

    live_processes = [
        {"name": "Hyprland", "pid": 101, "executable": "/usr/bin/Hyprland", "command": "Hyprland"},
        {"name": "quickshell", "pid": 102, "executable": "/usr/bin/quickshell", "command": "quickshell"},
    ]
    observations = iter([
        (
            {},
            [],
            {"argv": ["hyprctl", "version"], "exitCode": 127, "stdout": "", "stderr": "not live"},
        ),
        (
            {"XDG_SESSION_TYPE": "wayland"},
            live_processes,
            {"argv": ["hyprctl", "version"], "exitCode": 0, "stdout": "Hyprland 0.56.2\n", "stderr": ""},
        ),
    ])
    stage_events = []
    sleeps = []
    monotonic_values = iter([0.0, 901.0])
    ready_environment = probe_namespace["wait_for_desktop"](
        observe=lambda: next(observations),
        read_uwsm_state=lambda: {
            "ActiveState": "failed",
            "SubState": "failed",
            "Result": "timeout",
            "ExecMainStatus": "0",
        },
        emit=lambda events: stage_events.extend(events),
        monotonic=lambda: next(monotonic_values),
        sleep=lambda seconds: sleeps.append(seconds),
        slow_start_seconds=900,
    )
    stage_states = [(stage, status) for stage, status, _attempt, _message in stage_events]
    check(
        ready_environment == {"XDG_SESSION_TYPE": "wayland"}
        and ("autologin", "ready") in stage_states
        and ("uwsm", "started") in stage_states
        and ("uwsm", "failed") in stage_states
        and ("report", "failed") in stage_states
        and ("hyprland", "ready") in stage_states
        and ("quickshell", "ready") in stage_states
        and ("uwsm", "ready") in stage_states
        and sleeps == [10],
        "startup observer records UWSM timeout evidence, keeps polling, and reaches the real desktop",
    )

    report_emissions = []
    failed_report_stages = []
    probe_namespace["watch"](
        wait=lambda: {"XDG_SESSION_TYPE": "wayland"},
        read_environment=lambda: {"XDG_SESSION_TYPE": "wayland"},
        build=lambda environment: {"schemaVersion": 1, "session": environment["XDG_SESSION_TYPE"]},
        emit=lambda payload, attempt: report_emissions.append((payload, attempt)) or attempt == 2,
        emit_stage=lambda events: failed_report_stages.extend(events),
        delivered=lambda: False,
        sleep=lambda _seconds: None,
    )
    check(
        [attempt for _payload, attempt in report_emissions] == [1, 2]
        and failed_report_stages == [(
            "report",
            "failed",
            1,
            "report is complete but no guest diagnostics device accepted it; retrying",
        )],
        "final authenticity report persists and retries until a diagnostics device accepts it",
    )

    with tempfile.TemporaryDirectory(prefix="omarchy-report-once.") as temporary:
        scratch = pathlib.Path(temporary)
        state_path = scratch / "stage-state.json"
        selected_report = scratch / "guest-report.json"
        report_payload = {"schemaVersion": 1, "source": "authentic guest"}
        accepted_frames = []

        def accept_report(frames: Iterable[str]) -> pathlib.Path:
            accepted_frames.append(list(frames))
            return fake_a

        first_delivery = probe_namespace["emit_report"](
            report_payload,
            1,
            state_path=state_path,
            selected_report_path=selected_report,
            write_frames=accept_report,
        )
        complete = probe_namespace["report_delivery_complete"](
            state_path=state_path,
            selected_report_path=selected_report,
        )
        second_delivery = probe_namespace["emit_report"](
            {"schemaVersion": 1, "source": "must not replace delivered evidence"},
            2,
            state_path=state_path,
            selected_report_path=selected_report,
            write_frames=accept_report,
        )
        waited = []
        probe_namespace["watch"](
            delivered=lambda: probe_namespace["report_delivery_complete"](
                state_path=state_path,
                selected_report_path=selected_report,
            ),
            wait=lambda: waited.append(True) or {},
        )
        delivered_state = json.loads(state_path.read_text())
        check(
            first_delivery
            and complete
            and second_delivery
            and len(accepted_frames) == 1
            and not waited
            and delivered_state["reportPendingSha256"] is None
            and delivered_state["reportDeliveredSha256"]
            == probe_namespace["_report_digest"](report_payload),
            "successful report delivery is durably guarded across service starts",
        )

    with tempfile.TemporaryDirectory(prefix="omarchy-report-partial.") as temporary:
        scratch = pathlib.Path(temporary)
        state_path = scratch / "stage-state.json"
        selected_report = scratch / "guest-report.json"
        report_payload = {"schemaVersion": 1, "source": "partial test"}
        partial_attempts = []

        def interrupt_report(frames: Iterable[str]) -> pathlib.Path:
            partial_attempts.append(list(frames))
            raise probe_namespace["PartialDiagnosticWrite"](fake_a, 5, 100)

        interrupted = False
        try:
            probe_namespace["emit_report"](
                report_payload,
                1,
                state_path=state_path,
                selected_report_path=selected_report,
                write_frames=interrupt_report,
            )
        except probe_namespace["PartialDiagnosticWrite"]:
            interrupted = True
        duplicate_blocked = False
        try:
            probe_namespace["emit_report"](
                report_payload,
                2,
                state_path=state_path,
                selected_report_path=selected_report,
                write_frames=interrupt_report,
            )
        except RuntimeError:
            duplicate_blocked = True
        pending_state = json.loads(state_path.read_text())
        check(
            interrupted
            and duplicate_blocked
            and len(partial_attempts) == 1
            and pending_state["reportPendingSha256"]
            == probe_namespace["_report_digest"](report_payload)
            and pending_state["reportDeliveredSha256"] is None,
            "interrupted report delivery remains reserved and cannot duplicate",
        )

    with tempfile.TemporaryDirectory(prefix="omarchy-report-symlink.") as temporary:
        scratch = pathlib.Path(temporary)
        victim = scratch / "victim"
        victim.write_text("unchanged")
        selected_report = scratch / "guest-report.json"
        selected_report.symlink_to(victim)
        probe_namespace["persist_report"](
            {"schemaVersion": 1},
            selected_report_path=selected_report,
        )
        check(
            victim.read_text() == "unchanged"
            and selected_report.is_file()
            and not selected_report.is_symlink()
            and (selected_report.stat().st_mode & 0o777) == 0o600
            and not list(scratch.glob(".*.tmp")),
            "atomic report persistence replaces symlinks without following them",
        )

    valid_monitor = {
        "width": 1600,
        "height": 900,
        "scale": 1,
        "disabled": False,
        "dpmsStatus": True,
    }
    check(
        probe_namespace["monitor_contract_matches"]([valid_monitor])
        and not probe_namespace["monitor_contract_matches"](
            [valid_monitor, {**valid_monitor, "disabled": True}]
        )
        and not probe_namespace["monitor_contract_matches"](
            [{**valid_monitor, "dpmsStatus": False}]
        )
        and not probe_namespace["monitor_contract_matches"](
            [{**valid_monitor, "scale": 2}]
        ),
        "guest report enforces the exact one-monitor 1600x900 scale-1 DPMS contract",
    )
    version_matches = probe_namespace["omarchy_version_matches"]
    check(
        version_matches("4.0.0.alpha", "4.0.0.alpha")
        and version_matches("4.0.0.alpha-1", "4.0.0.alpha")
        and version_matches("4.0.0.alpha-2.1", "4.0.0.alpha")
        and not version_matches("prefix-4.0.0.alpha-1", "4.0.0.alpha")
        and not version_matches("4.0.0.alpha-0", "4.0.0.alpha")
        and not version_matches("4.0.0.alpha-other", "4.0.0.alpha"),
        "guest Omarchy version proof uses the exact acceptance grammar",
    )
    sanitized = probe_namespace["trusted_environment"](
        {
            "PATH": "/tmp/attacker",
            "LD_PRELOAD": "/tmp/attacker.so",
            "XDG_SESSION_TYPE": "wayland",
            "HYPRLAND_INSTANCE_SIGNATURE": "trusted-instance",
        }
    )
    session_missing_rejected = False
    try:
        probe_namespace["build_report"]({})
    except RuntimeError:
        session_missing_rejected = True
    check(
        sanitized["PATH"] == "/usr/local/bin:/usr/bin"
        and "LD_PRELOAD" not in sanitized
        and sanitized["XDG_SESSION_TYPE"] == "wayland"
        and sanitized["HYPRLAND_INSTANCE_SIGNATURE"] == "trusted-instance"
        and probe_namespace["command_argv"](["hyprctl", "version"])
        == ["/usr/bin/hyprctl", "version"]
        and session_missing_rejected,
        "identity commands use trusted absolute paths and a whitelisted Wayland environment",
    )

    bash_profile = (GUEST / "overlay/etc/skel/.bash_profile").read_text()
    exact_uwsm = "exec uwsm start -g -1 -e -D Hyprland hyprland.desktop"
    check(
        bash_profile.count(exact_uwsm) == 1
        and bash_profile.count("export UWSM_WAIT_VARNAMES_TIMEOUT=900") == 1
        and bash_profile.find("export UWSM_WAIT_VARNAMES_TIMEOUT=900")
        < bash_profile.find(exact_uwsm)
        and bash_profile.find("omarchy-web-guest-probe.service") < bash_profile.find(exact_uwsm),
        "tty1 diagnostics and bounded UWSM generator input precede the unchanged upstream session command",
    )
    probe_unit = (GUEST / "overlay/usr/lib/systemd/user/omarchy-web-guest-probe.service").read_text()
    check(
        "ExecStart=/usr/local/bin/omarchy-web-guest-probe --watch" in probe_unit
        and "Type=simple" in probe_unit
        and "RemainAfterExit=yes" in probe_unit
        and "Restart=on-failure" in probe_unit
        and "Nice=19" in probe_unit
        and "IOSchedulingClass=idle" in probe_unit
        and "UMask=0077" in probe_unit
        and "UnsetEnvironment=" in probe_unit
        and "graphical-session.target" not in probe_unit
        and "ConditionEnvironment" not in probe_unit,
        "startup observer runs before graphical readiness, fails closed, and remains active after delivery",
    )
    uwsm_dropins = [
        (
            GUEST
            / "overlay/etc/systemd/user"
            / unit
            / "90-omarchy-web-slow-tcg.conf"
        ).read_text()
        for unit in (
            "wayland-wm@.service.d",
            "wayland-session-waitenv.service.d",
        )
    ]
    check(
        all(
            "TimeoutStartSec=15min" in dropin and "ExecStart" not in dropin
            for dropin in uwsm_dropins
        ),
        "web-only UWSM drop-ins extend only the bounded compositor and environment startup timeouts",
    )
    autologin_dropin = (GUEST / "overlay/etc/systemd/system/getty@tty1.service.d/autologin.conf").read_text()
    check("RestartSec=5s" in autologin_dropin, "tty1 autologin retry loop has a bounded backoff")

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

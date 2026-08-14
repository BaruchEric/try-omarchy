import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDeployment } from "../check-deployment.mjs";
import { verifyArtifactManifest } from "../verify-artifact-manifest.mjs";
import { verifyGuestReport } from "../verify-guest-report.mjs";
import { verifyRuntimeReport } from "../verify-runtime-report.mjs";
import { verifyStatic } from "../verify-static.mjs";

const commit = "a".repeat(40);
const treeSha256 = "b".repeat(64);
const builderDigest = `sha256:${"c".repeat(64)}`;

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function baseManifest(artifacts) {
  return {
    schemaVersion: 1,
    product: "Omarchy browser demo",
    upstream: {
      repository: "https://github.com/basecamp/omarchy",
      commit,
      ref: "v-test",
      version: "4.0.0-test",
      license: "MIT",
      treeSha256,
    },
    runtime: {
      name: "qemu-wasm",
      repository: "https://github.com/example/qemu-wasm",
      commit: "d".repeat(40),
      license: "GPL-2.0-only",
      modified: true,
      correspondingSourceUrl:
        "https://downloads.example/source/qemu-wasm-test.tar.zst",
    },
    build: {
      builtAt: "2026-08-14T12:00:00Z",
      builderImageDigest: builderDigest,
      sourceDateEpoch: 1786708800,
    },
    guest: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      display: { width: 1600, height: 900 },
    },
    artifacts,
    licenses: [
      {
        component: "omarchy",
        spdx: "MIT",
        noticePath: "licenses/omarchy.txt",
        sourceUrl: "https://github.com/basecamp/omarchy",
      },
      {
        component: "qemu-wasm",
        spdx: "GPL-2.0-only",
        noticePath: "licenses/qemu.txt",
        sourceUrl: "https://github.com/example/qemu-wasm",
      },
      {
        component: "linux",
        spdx: "GPL-2.0-only WITH Linux-syscall-note",
        noticePath: "licenses/linux.txt",
        sourceUrl: "https://kernel.org",
      },
    ],
  };
}

function baseGuestReport() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:01:00Z",
    provenance: {
      repository: "https://github.com/basecamp/omarchy",
      commit,
      version: "4.0.0-test",
      treeSha256,
      imageSha256: "e".repeat(64),
    },
    system: {
      architecture: "x86_64",
      distribution: "Arch Linux",
      kernel: "6.12.0-arch1-1",
      sessionType: "wayland",
    },
    components: [
      {
        role: "compositor",
        name: "Hyprland",
        version: "0.50.0",
        executable: "/usr/bin/Hyprland",
      },
      {
        role: "shell",
        name: "quickshell",
        version: "0.2.0",
        executable: "/usr/bin/quickshell",
      },
    ],
    processes: [
      { name: "Hyprland", pid: 501, executable: "/usr/bin/Hyprland" },
      { name: "quickshell", pid: 540, executable: "/usr/bin/quickshell" },
    ],
    commands: [
      { argv: ["uname", "-m"], exitCode: 0, stdout: "x86_64\n" },
      {
        argv: ["hyprctl", "version"],
        exitCode: 0,
        stdout: "Hyprland 0.50.0\n",
      },
      {
        argv: ["hyprctl", "monitors", "-j"],
        exitCode: 0,
        stdout: '[{"width":1600,"height":900}]\n',
      },
      {
        argv: ["omarchy-version"],
        exitCode: 0,
        stdout: "4.0.0-test\n",
      },
    ],
    configs: [
      {
        path: "/home/omarchy/.config/hypr/hyprland.conf",
        sha256: "f".repeat(64),
        origin: "omarchy-upstream",
      },
    ],
  };
}

function baseRuntimeReport() {
  const journeyIds = [
    "desktop-visible",
    "menu-open",
    "terminal-open",
    "identity-command",
    "second-app-open",
    "windows-tiled",
    "workspace-switch",
    "theme-change",
    "terminal-close",
    "demo-reset",
  ];
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-14T12:06:00Z",
    artifactManifestSha256: "1".repeat(64),
    environment: {
      browser: "Chromium",
      browserVersion: "140.0.0",
      operatingSystem: "Linux",
      networkProfile: "reference",
      devicePixelRatio: 1,
      crossOriginIsolated: true,
      sharedArrayBuffer: true,
    },
    authenticity: {
      evidenceSource: "guest-agent",
      guestArchitecture: "x86_64",
      omarchyCommit: commit,
      framebufferSource: "qemu-guest",
    },
    display: {
      guestWidth: 1600,
      guestHeight: 900,
      canvasCssWidth: 1600,
      canvasCssHeight: 900,
      canvasBackingWidth: 1600,
      canvasBackingHeight: 900,
      framebufferPixelFormat: "xrgb8888",
    },
    input: {
      keyboard: true,
      modifiers: true,
      pointerMotion: true,
      pointerButtons: true,
      wheel: true,
      focusRecovery: true,
      shortcutAlternative: true,
    },
    journey: journeyIds.map((id) => ({ id, passed: true, guestAck: true })),
    performance: {
      coldDesktopReadyMs: 40000,
      cachedDesktopReadyMs: 12000,
      inputLatencyP95Ms: 140,
      fpsP05: 14,
      fpsP50: 24,
      memoryPeakMiB: 2200,
      longestBlackFrameMs: 800,
      runtimeCrashCount: 0,
      consoleErrorCount: 0,
      pageErrorCount: 0,
      unexpectedGuestNetworkRequests: 0,
    },
    durationMs: 300000,
  };
}

test("static verification contract is internally complete", async () => {
  const result = await verifyStatic();
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));
});

test("artifact manifest validates files, digests, roles, and licenses", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "omarchy-verify-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const roles = [
    ["emulator-wasm", "runtime.wasm", "application/wasm"],
    ["emulator-worker", "runtime.worker.js", "text/javascript"],
    ["guest-kernel", "vmlinuz", "application/octet-stream"],
    ["guest-rootfs", "rootfs.img", "application/octet-stream"],
    ["guest-metadata", "guest.json", "application/json"],
    ["license-bundle", "licenses.tar", "application/x-tar"],
  ];
  const artifacts = [];
  for (const [role, file, mediaType] of roles) {
    const contents = Buffer.from(`fixture:${role}`);
    await writeFile(path.join(temporaryRoot, file), contents);
    artifacts.push({
      path: file,
      role,
      bytes: contents.length,
      sha256: digest(contents),
      mediaType,
    });
  }
  const manifest = baseManifest(artifacts);
  const result = await verifyArtifactManifest(manifest, {
    artifactRoot: temporaryRoot,
  });
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));

  manifest.artifacts[0].sha256 = "0".repeat(64);
  const corrupted = await verifyArtifactManifest(manifest, {
    artifactRoot: temporaryRoot,
  });
  assert.equal(corrupted.passed, false);
  assert.ok(
    corrupted.checks.some(
      (check) => check.id.endsWith("SHA256") && !check.passed,
    ),
  );
});

test("artifact paths cannot escape the artifact root", async () => {
  const contents = Buffer.from("escape");
  const manifest = baseManifest([
    {
      path: "../escape.wasm",
      role: "emulator-wasm",
      bytes: contents.length,
      sha256: digest(contents),
      mediaType: "application/wasm",
    },
  ]);
  const result = await verifyArtifactManifest(manifest, {
    artifactRoot: os.tmpdir(),
  });
  assert.equal(result.passed, false);
  assert.ok(result.checks.some((check) => check.id.endsWith("FILE")));
});

test("guest report proves Omarchy and live Hyprland identity", async () => {
  const report = baseGuestReport();
  const manifest = baseManifest([]);
  const result = await verifyGuestReport(report, { manifest });
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));

  report.provenance.commit = "9".repeat(40);
  const mismatch = await verifyGuestReport(report, { manifest });
  assert.equal(mismatch.passed, false);
  assert.ok(mismatch.checks.some((check) => check.id === "GUEST-002" && !check.passed));
});

test("runtime report enforces the full journey and performance thresholds", async () => {
  const report = baseRuntimeReport();
  const result = await verifyRuntimeReport(report);
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));

  report.performance.inputLatencyP95Ms = 151;
  report.journey.find((step) => step.id === "theme-change").guestAck = false;
  const regression = await verifyRuntimeReport(report);
  assert.equal(regression.passed, false);
  assert.ok(regression.checks.some((check) => check.id === "INP-002" && !check.passed));
  assert.ok(regression.checks.some((check) => check.id === "RUN-001" && !check.passed));
});

test("deployment check verifies isolation, range requests, caching, and Wasm MIME", async () => {
  const manifest = {
    artifacts: [
      {
        path: "runtime-a1b2.wasm",
        role: "emulator-wasm",
      },
    ],
  };
  const calls = [];
  const fetchImpl = async (request, options = {}) => {
    const url = new URL(request);
    calls.push({ url: url.href, options });
    if (url.pathname === "/") {
      return new Response("<!doctype html>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
        },
      });
    }
    if (url.pathname === "/omarchy/artifact-manifest.json") {
      return Response.json(manifest);
    }
    return new Response("x", {
      status: 206,
      headers: {
        "content-range": "bytes 0-0/1024",
        "content-type": "application/wasm",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  };
  const result = await checkDeployment("https://demo.example/", {
    manifestUrl: "/omarchy/artifact-manifest.json",
    fetchImpl,
  });
  assert.equal(result.passed, true, JSON.stringify(result.toJSON(), null, 2));
  assert.equal(calls.at(-1).options.headers.range, "bytes=0-0");
});

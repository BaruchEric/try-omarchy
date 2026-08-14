#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  VerificationResult,
  finishCli,
  numeric,
  parseArguments,
  readJson,
  repositoryRoot,
  verificationDirectory,
} from "./lib.mjs";

const verificationFiles = [
  "scripts/verification/acceptance-contract.json",
  "scripts/verification/artifact-manifest.schema.json",
  "scripts/verification/guest-report.schema.json",
  "scripts/verification/runtime-report.schema.json",
  "scripts/verification/lib.mjs",
  "scripts/verification/verify-artifact-manifest.mjs",
  "scripts/verification/verify-guest-report.mjs",
  "scripts/verification/verify-runtime-report.mjs",
  "scripts/verification/check-deployment.mjs",
  "docs/acceptance.md",
  "docs/verification.md",
  "docs/legal-distribution.md"
];

export async function verifyStatic(root = repositoryRoot) {
  const result = new VerificationResult("verification architecture");
  const missingFiles = [];
  for (const relativePath of verificationFiles) {
    try {
      await access(path.join(root, relativePath));
    } catch {
      missingFiles.push(relativePath);
    }
  }
  result.check(
    "STATIC-001",
    missingFiles.length === 0,
    "verification contract, schemas, validators, and operator docs exist",
    { missingFiles },
  );

  const contract = await readJson(
    path.join(root, "scripts/verification/acceptance-contract.json"),
  );
  const gates = Array.isArray(contract?.gates) ? contract.gates : [];
  const gateIds = gates.map((gate) => gate?.id);
  const duplicateGateIds = gateIds.filter(
    (id, index) => gateIds.indexOf(id) !== index,
  );
  result.check(
    "STATIC-002",
    contract?.schemaVersion === 1 &&
      contract?.product === "Omarchy browser demo" &&
      gates.length >= 20,
    "acceptance contract has a supported schema and full gate set",
    { schemaVersion: contract?.schemaVersion, gateCount: gates.length },
  );
  result.check(
    "STATIC-003",
    duplicateGateIds.length === 0 &&
      gates.every(
        (gate) =>
          /^[A-Z]+-\d{3}$/.test(gate?.id ?? "") &&
          typeof gate.area === "string" &&
          typeof gate.blocking === "boolean" &&
          typeof gate.automated === "boolean" &&
          typeof gate.evidence === "string" &&
          typeof gate.assertion === "string",
      ),
    "gate IDs are unique and every gate declares enforcement and evidence",
    { duplicateGateIds },
  );
  result.check(
    "STATIC-004",
    Object.values(contract?.thresholds ?? {}).every(
      (threshold) => numeric(threshold) && threshold >= 0,
    ),
    "all release thresholds are finite non-negative numbers",
  );
  result.check(
    "STATIC-005",
    Array.isArray(contract?.journeySteps) &&
      contract.journeySteps.length === 10 &&
      new Set(contract.journeySteps).size === contract.journeySteps.length,
    "the five-minute journey has ten unique machine-readable steps",
  );

  const schemaFiles = [
    "artifact-manifest.schema.json",
    "guest-report.schema.json",
    "runtime-report.schema.json",
  ];
  const schemas = await Promise.all(
    schemaFiles.map((name) => readJson(path.join(verificationDirectory, name))),
  );
  result.check(
    "STATIC-006",
    schemas.every(
      (schema) =>
        schema?.$schema === "https://json-schema.org/draft/2020-12/schema" &&
        schema?.type === "object" &&
        Array.isArray(schema?.required),
    ),
    "evidence schemas are Draft 2020-12 object schemas with required fields",
  );

  const acceptanceDoc = await readFile(
    path.join(root, "docs/acceptance.md"),
    "utf8",
  );
  const undocumentedGates = gateIds.filter(
    (id) => !acceptanceDoc.includes(`\`${id}\``),
  );
  result.check(
    "STATIC-007",
    undocumentedGates.length === 0,
    "every machine-readable gate appears in the human acceptance plan",
    { undocumentedGates },
  );

  const legalDoc = await readFile(
    path.join(root, "docs/legal-distribution.md"),
    "utf8",
  );
  const legalAnchors = [
    "github.com/basecamp/omarchy/blob",
    "github.com/ktock/qemu-wasm",
    "GPL-2.0",
    "corresponding source",
    "trademark",
    "SBOM",
  ];
  const missingLegalAnchors = legalAnchors.filter(
    (anchor) => !legalDoc.toLowerCase().includes(anchor.toLowerCase()),
  );
  result.check(
    "STATIC-008",
    missingLegalAnchors.length === 0,
    "distribution checklist covers upstream terms, copyleft, SBOM, and branding",
    { missingLegalAnchors },
  );

  const [runtimeConfig, runtimeLock, guestSpec, serverSource, runtimeSource] =
    await Promise.all([
      readJson(path.join(root, "runtime/config/demo.json")),
      readJson(path.join(root, "runtime/upstream.lock.json")),
      readJson(path.join(root, "guest/spec.json")),
      readFile(path.join(root, "runtime/scripts/serve.mjs"), "utf8"),
      readFile(path.join(root, "runtime/web/runtime.mjs"), "utf8"),
    ]);
  const qemuArguments = runtimeConfig?.qemu?.arguments ?? [];
  const qemuDevices = qemuArguments
    .map((argument, index) =>
      argument === "-device" ? qemuArguments[index + 1] : undefined,
    )
    .filter(Boolean);
  result.check(
    "STATIC-009",
    runtimeLock?.qemuWasm?.repository ===
      "https://github.com/ktock/qemu-wasm.git" &&
      /^[0-9a-f]{40}$/i.test(runtimeLock?.qemuWasm?.commit ?? ""),
    "QEMU-Wasm is pinned to the expected upstream at a full commit SHA",
    runtimeLock?.qemuWasm,
  );
  result.check(
    "STATIC-010",
    qemuArguments.includes("-display") &&
      qemuArguments[qemuArguments.indexOf("-display") + 1]?.startsWith("sdl") &&
      !qemuArguments.includes("-nographic") &&
      qemuDevices.some((device) => device.startsWith("virtio-vga")) &&
      qemuDevices.some((device) => device.startsWith("virtio-keyboard")) &&
      qemuDevices.some((device) => device.startsWith("virtio-tablet")),
    "runtime requests a graphical SDL/virtio display and virtual input devices",
    { devices: qemuDevices },
  );
  result.check(
    "STATIC-011",
    guestSpec?.image?.architecture === "x86_64" &&
      guestSpec?.upstream?.repository?.replace(/\.git$/, "") ===
        "https://github.com/basecamp/omarchy" &&
      /^[0-9a-f]{40}$/i.test(guestSpec?.upstream?.commit ?? "") &&
      /^[0-9a-f]{40}$/i.test(guestSpec?.upstream?.tree ?? "") &&
      guestSpec?.upstream?.license === "MIT" &&
      guestSpec?.authenticity?.requiredPaths?.includes("LICENSE") &&
      guestSpec?.authenticity?.requiredPaths?.includes("bin/omarchy") &&
      guestSpec?.authenticity?.requiredPaths?.includes("bin/omarchy-menu") &&
      guestSpec?.authenticity?.requiredPaths?.includes("bin/omarchy-theme-set"),
    "guest spec pins authentic Omarchy source and required runtime entry points",
    guestSpec?.upstream,
  );
  result.check(
    "STATIC-012",
    runtimeConfig?.display?.width === guestSpec?.guest?.virtualDisplay?.width &&
      runtimeConfig?.display?.height === guestSpec?.guest?.virtualDisplay?.height &&
      runtimeConfig?.display?.width === contract.thresholds.guestWidth &&
      runtimeConfig?.display?.height === contract.thresholds.guestHeight &&
      runtimeConfig?.qemu?.memoryMiB >= guestSpec?.runtime?.minimumMemoryMiB &&
      qemuArguments.includes("-nic") &&
      qemuArguments[qemuArguments.indexOf("-nic") + 1] === "none",
    "runtime and guest agree on display/memory and default to no guest network",
    {
      runtimeDisplay: runtimeConfig?.display,
      guestDisplay: guestSpec?.guest?.virtualDisplay,
      memoryMiB: runtimeConfig?.qemu?.memoryMiB,
      minimumMemoryMiB: guestSpec?.runtime?.minimumMemoryMiB,
    },
  );
  result.check(
    "STATIC-013",
    serverSource.includes('"Cross-Origin-Opener-Policy": "same-origin"') &&
      serverSource.includes('"Cross-Origin-Embedder-Policy": "require-corp"') &&
      serverSource.includes('"Accept-Ranges": "bytes"') &&
      serverSource.includes('[".wasm", "application/wasm"]') &&
      serverSource.includes("immutable"),
    "local production-like server declares isolation, ranges, Wasm MIME, and immutable asset caching",
  );
  result.check(
    "STATIC-014",
    runtimeSource.includes("crossOriginIsolated") &&
      runtimeSource.includes("SharedArrayBuffer") &&
      runtimeSource.includes("OffscreenCanvas") &&
      runtimeSource.includes("wasmThreads") &&
      runtimeSource.includes('this.#setPhase("unsupported"'),
    "browser runtime refuses unsupported threaded-Wasm environments",
  );

  return result;
}

async function main() {
  const { values } = parseArguments(process.argv.slice(2), {
    root: "string",
    json: "boolean",
  });
  const result = await verifyStatic(
    values.root ? path.resolve(values.root) : repositoryRoot,
  );
  finishCli(result, { json: values.json });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}

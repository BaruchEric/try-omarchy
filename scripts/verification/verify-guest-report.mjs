#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  VerificationResult,
  commandKey,
  finishCli,
  isFullGitSha,
  isIsoDate,
  isRecord,
  isSha256,
  parseArguments,
  readContract,
  readJson,
} from "./lib.mjs";

const OMARCHY_REPOSITORY = "https://github.com/basecamp/omarchy";

export async function verifyGuestReport(report, { manifest } = {}) {
  const contract = await readContract();
  const result = new VerificationResult("guest authenticity report");
  const provenance = report?.provenance;
  const system = report?.system;
  const components = Array.isArray(report?.components) ? report.components : [];
  const processes = Array.isArray(report?.processes) ? report.processes : [];
  const commands = Array.isArray(report?.commands) ? report.commands : [];
  const configs = Array.isArray(report?.configs) ? report.configs : [];

  result.check(
    "GUEST-001",
    report?.schemaVersion === 1 && isIsoDate(report?.generatedAt),
    "report schema and generation timestamp are valid",
  );
  result.check(
    "AUTH-001",
    provenance?.repository === OMARCHY_REPOSITORY &&
      isFullGitSha(provenance?.commit) &&
      typeof provenance?.version === "string" &&
      provenance.version.length > 0 &&
      isSha256(provenance?.treeSha256),
    "guest records immutable Omarchy source provenance",
    provenance,
  );
  result.check(
    "AUTH-002",
    system?.architecture === "x86_64" &&
      system?.distribution === "Arch Linux" &&
      system?.sessionType === "wayland" &&
      typeof system?.kernel === "string" &&
      system.kernel.length > 0,
    "guest is x86_64 Arch Linux in a Wayland session",
    system,
  );

  if (manifest) {
    result.check(
      "GUEST-002",
      provenance?.repository === manifest?.upstream?.repository &&
        provenance?.commit?.toLowerCase() ===
          manifest?.upstream?.commit?.toLowerCase() &&
        provenance?.version === manifest?.upstream?.version &&
        (!manifest?.upstream?.treeSha256 ||
          provenance?.treeSha256?.toLowerCase() ===
            manifest.upstream.treeSha256.toLowerCase()),
      "running guest provenance matches the release manifest",
      {
        guest: provenance,
        manifest: manifest?.upstream,
      },
    );
  }

  const compositor = components.find(
    (component) => component?.role === "compositor",
  );
  const compositorProcess = processes.find(
    (process) =>
      typeof process?.name === "string" &&
      process.name.toLowerCase() === "hyprland" &&
      Number.isInteger(process.pid) &&
      process.pid > 1,
  );
  result.check(
    "AUTH-003",
    compositor?.name?.toLowerCase() === "hyprland" &&
      typeof compositor?.version === "string" &&
      compositor.version.length > 0 &&
      typeof compositor?.executable === "string" &&
      compositor.executable.startsWith("/") &&
      Boolean(compositorProcess),
    "Hyprland component and live process evidence are present",
    { compositor, compositorProcess },
  );

  const desktopShell = components.find((component) => component?.role === "shell");
  const shellProcess = processes.find(
    (process) =>
      typeof process?.name === "string" &&
      typeof desktopShell?.name === "string" &&
      process.name.toLowerCase().includes(desktopShell.name.toLowerCase()),
  );
  result.check(
    "GUEST-003",
    typeof desktopShell?.name === "string" &&
      desktopShell.name.length > 0 &&
      typeof desktopShell?.version === "string" &&
      desktopShell.version.length > 0 &&
      Boolean(shellProcess),
    "the pinned Omarchy desktop shell has component and process evidence",
    { desktopShell, shellProcess },
  );

  const commandMap = new Map(
    commands.map((command) => [commandKey(command?.argv), command]),
  );
  const missingCommands = contract.requiredGuestCommands.filter((required) => {
    const command = commandMap.get(required);
    return !command || command.exitCode !== 0 || typeof command.stdout !== "string";
  });
  result.check(
    "GUEST-004",
    missingCommands.length === 0,
    "required identity and compositor commands succeeded inside the guest",
    { missingCommands },
  );
  result.check(
    "GUEST-005",
    commandMap.get("uname -m")?.stdout?.trim() === "x86_64" &&
      /hyprland/i.test(commandMap.get("hyprctl version")?.stdout ?? "") &&
      commandMap.get("omarchy-version")?.stdout?.includes(provenance?.version ?? ""),
    "identity command output agrees with structured provenance",
  );

  const validConfigs =
    configs.length > 0 &&
    configs.every(
      (config) =>
        isRecord(config) &&
        typeof config.path === "string" &&
        config.path.startsWith("/") &&
        isSha256(config.sha256) &&
        config.origin === "omarchy-upstream",
    );
  result.check(
    "GUEST-006",
    validConfigs,
    "tracked desktop configuration files identify their upstream origin and digest",
  );

  return result;
}

async function main() {
  const { values, positional } = parseArguments(process.argv.slice(2), {
    manifest: "string",
    json: "boolean",
  });
  if (!positional[0]) {
    throw new Error(
      "Usage: verify-guest-report.mjs <guest-report.json> [--manifest manifest.json] [--json]",
    );
  }
  const [report, manifest] = await Promise.all([
    readJson(path.resolve(positional[0])),
    values.manifest ? readJson(path.resolve(values.manifest)) : undefined,
  ]);
  const result = await verifyGuestReport(report, { manifest });
  finishCli(result, { json: values.json });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
